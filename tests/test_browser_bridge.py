"""Exercise the real HTTP/WS server, media timeline and single-touch lifecycle.

macOS (Foundation + clang), Python standard library only. No iPhone is needed.
"""
from pathlib import Path
import base64
import hashlib
import http.client
import json
import os
import queue
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def fixture(path):
    avcc = bytes.fromhex('0142001effe100046742001e01000268ce')
    frame = bytes.fromhex('0000000265b8')
    path.write_bytes(struct.pack('!I', len(avcc)) + avcc + struct.pack('!I', len(frame)) + frame)


class WS:
    def __init__(self, port, route, origin=None, expected=101):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=3)
        self.buffer = b''
        key = base64.b64encode(os.urandom(16)).decode()
        host = f'127.0.0.1:{port}'
        request = (f'GET {route} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                   f'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nOrigin: {origin or "http://" + host}\r\n'
                   '\r\n')
        self.sock.sendall(request.encode())
        while b'\r\n\r\n' not in self.buffer:
            data = self.sock.recv(65536)
            assert data, 'server closed before handshake'
            self.buffer += data
        headers, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
        assert int(headers.split()[1]) == expected, headers
        if expected == 101:
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
            assert accept in headers

    def read(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            assert chunk, 'unexpected WS EOF'
            self.buffer += chunk
        result, self.buffer = self.buffer[:count], self.buffer[count:]
        return result

    def receive(self):
        a, b = self.read(2)
        assert a == 0x82 and not b & 0x80, (a, b)
        size = b & 127
        if size == 126:
            size = struct.unpack('!H', self.read(2))[0]
        if size == 127:
            size = struct.unpack('!Q', self.read(8))[0]
        return self.read(size)

    def send(self, message):
        data = json.dumps(message).encode()
        mask = os.urandom(4)
        header = bytes([0x81, 0x80 | len(data)]) if len(data) < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', len(data))
        self.sock.sendall(header + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(data)))

    def close(self):
        self.sock.close()


def main():
    if sys.platform != 'darwin':
        print('SKIP: browser bridge integration requires macOS Foundation')
        return
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        fixture(work / 'fixture.bin')
        subprocess.run(['clang', '-fobjc-arc', '-Wno-deprecated-declarations', '-framework', 'Foundation',
                        str(ROOT / 'source/browser_bridge.m'), str(ROOT / 'tests/browser_bridge_harness.m'),
                        '-o', str(work / 'bridge')], check=True)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        process = subprocess.Popen([str(work / 'bridge'), str(port), str(work / 'fixture.bin'), '320x180'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        events = queue.Queue()
        def reader():
            for line in process.stdout:
                events.put(line.strip())
        threading.Thread(target=reader, daemon=True).start()
        def wait_event(prefix, timeout=3):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                if event.startswith(prefix):
                    return event
            raise AssertionError('Missing event: ' + prefix)
        def command(text):
            process.stdin.write(text)
            process.stdin.flush()
            time.sleep(0.1)
        def status():
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            connection.request('GET', '/status', headers={})
            response = connection.getresponse(); assert response.status == 200
            result = json.loads(response.read()); connection.close(); return result
        sockets = []
        try:
            wait_event('READY')
            ws = WS(port, '/control', origin='http://attacker.invalid', expected=403); ws.close()
            connection = http.client.HTTPConnection('127.0.0.1', port)
            connection.request('GET', '/', headers={'Host': f'attacker.invalid:{port}'})
            assert connection.getresponse().status == 400; connection.close()
            control = WS(port, '/control'); sockets.append(control)
            wait_event('TOUCH 3')  # input ownership transfer cancels local touch
            second = WS(port, '/control', expected=409); second.close()
            media = WS(port, '/media'); sockets.append(media)
            packet = media.receive()
            while packet[0] != 1:
                packet = media.receive()
            generation = struct.unpack('!I', packet[1:5])[0]
            assert struct.unpack('!HH', packet[5:9]) == (320, 180)
            command('r')
            assert status()['generation'] == generation, 'identical SPS/PPS must not reset playback or touch'
            times = []
            while len(times) < 3:
                packet = media.receive()
                if packet[0] == 2:
                    assert struct.unpack('!I', packet[1:5])[0] == generation
                    assert packet[5] == 1 and packet[14:] == bytes.fromhex('0000000265b8')
                    times.append(struct.unpack('!Q', packet[6:14])[0])
            assert 33000 <= times[1] - times[0] <= 34000, times
            for mode in ('d', 'z', 'n'):
                previous = status()
                command(mode)
                time.sleep(0.2)
                current = status()
                assert current['receivedFrames'] > previous['receivedFrames'] + 2
                if mode != 'n':
                    assert current['timestampFallbacks'] > previous['timestampFallbacks']
                sample_times = []
                while len(sample_times) < 5:
                    packet = media.receive()
                    if packet[0] == 2:
                        sample_times.append(struct.unpack('!Q', packet[6:14])[0])
                assert all(b > a for a, b in zip(sample_times, sample_times[1:])), sample_times
            def touch(phase, x=80, y=90, stream=generation):
                control.send(dict(type='touch', phase=phase, x=x, y=y, generation=stream))
            touch(0); assert wait_event('TOUCH 0') == 'TOUCH 0 80 90'
            touch(1, 120, 100); assert wait_event('TOUCH 1') == 'TOUCH 1 120 100'
            touch(2, 120, 100); wait_event('TOUCH 2')
            command('s'); time.sleep(2.1)
            assert status()['frameAgeMs'] > 2000
            touch(0); wait_event('TOUCH 0'); touch(2); wait_event('TOUCH 2')
            command('c')  # static screens must remain touchable without new frames
            touch(0); wait_event('TOUCH 0')
            # Keep a stationary long press alive, then stop holds: deadman cancel.
            for _ in range(5):
                control.send(dict(type='hold', generation=generation)); time.sleep(0.2)
            assert not any(e.startswith('TOUCH 3') for e in list(events.queue))
            wait_event('TOUCH 3', 2)
            touch(0); wait_event('TOUCH 0'); command('b'); wait_event('TOUCH 3')
            assert not status()['active'] and not status()['configured']
            command('f'); state = status(); assert state['active'] and state['configured']
            assert state['generation'] != generation
            touch(0)  # stale stream must not click the new session
            time.sleep(0.15)
            assert not any(e.startswith('TOUCH 0') for e in list(events.queue))
            control.send(dict(type='touch', phase=0, x=320, y=180, generation=state['generation']))
            wait_event('TOUCH 0 320 180'); control.close(); sockets.remove(control); wait_event('TOUCH 3')
            malformed = WS(port, '/control'); wait_event('TOUCH 3')
            malformed.send(dict(type='touch', phase=True, x=1, y=1, generation=state['generation']))
            assert malformed.sock.recv(1) == b''; malformed.close()
            print('PASS: passwordless HTTP/WS, duplicate AVC config, origin/host, one controller, AVC time, touch, deadman, foreground reset, stale generation')
        finally:
            for ws in sockets:
                ws.close()
            if process.poll() is None:
                command('q')
            try:
                _, error = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); _, error = process.communicate(); raise
            assert process.returncode == 0, error


if __name__ == '__main__':
    main()
