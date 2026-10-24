/* SPDX-License-Identifier: GPL-3.0-or-later
 * Local HTTP/WebSocket bridge. One nonblocking poll loop owns sockets; media
 * publishers only copy into bounded queues. No UIKit or video decoding here.
 */
#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <pthread.h>
#include <time.h>
#include <math.h>
#include <errno.h>
#include "browser_bridge.h"
#include "browser_assets.h"
#include "browser_jpeg.h"
#include "browser_rtc.h"
#ifndef SHOWCASE_RELEASE_VERSION
#define SHOWCASE_RELEASE_VERSION "development"
#endif
#ifndef SHOWCASE_BUILD_NUMBER
#define SHOWCASE_BUILD_NUMBER "development"
#endif

#define MAX_CLIENTS 8
#define MAX_QUEUE_BYTES (8 * 1024 * 1024)
#define MAX_FRAME_BYTES (4 * 1024 * 1024)

@interface SCBrowserClient : NSObject
@property int fd;
@property int role; /* 0 HTTP, 1 media, 2 control, 3 closing */
@property int transport; /* 0 compressed WS, 1 JPEG WS, 2 MJPEG HTTP, 3 WebRTC */
@property bool needsKey;
@property bool pressed;
@property bool upgradePending;
@property uint16_t x;
@property uint16_t y;
@property double heard;
@property double touched;
@property double lastMove;
@property double moveTokens;
@property size_t offset;
@property size_t queued;
@property (nonatomic, strong) NSMutableData *input;
@property (nonatomic, strong) NSMutableArray<NSData *> *output;
@end
@implementation SCBrowserClient
@end

static pthread_mutex_t browserLock = PTHREAD_MUTEX_INITIALIZER;
static pthread_t browserThread;
static bool running, active, wantKey;
static int listener = -1;
static uint16_t listenPort, videoWidth, videoHeight;
static uint32_t generation;
static uint64_t lastTime, timelineMicros, receivedFrames, timestampFallbacks;
static double lastArrival;
static bool haveTime;
static double lastFrameAt, lastKeyAt;
static NSData *configuration;
static NSData *decoderConfiguration;
static uint64_t congestionRecoveries;
static NSMutableArray<SCBrowserClient *> *clients;
static ShowcaseBrowserTouch touchCallback;
static ShowcaseBrowserResync resyncCallback;
static bool localPressed;
static uint16_t localX, localY;
static NSData *latestJPEG;
static uint32_t jpegGeneration;
static uint64_t jpegSequence;

static double browser_now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static uint64_t browser_nanos(void) { return (uint64_t)(browser_now() * 1e9); }
static void put_be(uint8_t *p, uint64_t n, unsigned bytes) {
    for (unsigned i = 0; i < bytes; i++) { p[bytes - i - 1] = n & 255; n >>= 8; }
}
static NSData *websocket_packet(NSData *payload, uint8_t opcode) {
    uint8_t header[10] = { (uint8_t)(0x80 | opcode), 0 };
    size_t size = 2, length = payload.length;
    if (length < 126) header[1] = length;
    else if (length <= 65535) { header[1] = 126; put_be(header + 2, length, 2); size = 4; }
    else { header[1] = 127; put_be(header + 2, length, 8); size = 10; }
    NSMutableData *result = [NSMutableData dataWithBytes:header length:size];
    [result appendData:payload];
    return result;
}
static void enqueue(SCBrowserClient *c, NSData *data) {
    [c.output addObject:data]; c.queued += data.length;
}
/* Never discard a partially written WS packet: doing so corrupts framing. */
static void discard_unsent(SCBrowserClient *c) {
    NSData *partial = (c.offset || c.upgradePending) && c.output.count ? c.output[0] : nil;
    [c.output removeAllObjects]; c.queued = 0;
    if (partial) enqueue(c, partial);
    else c.offset = 0;
}
static void release_touch(SCBrowserClient *c) {
    if (c.pressed && touchCallback) touchCallback(3, c.x, c.y, 0, browser_nanos());
    c.pressed = false;
}
static void release_local(void) {
    if (localPressed && touchCallback) touchCallback(3, localX, localY, 0, browser_nanos());
    localPressed = false;
}
static void invalidate_stream(void) {
    release_local();
    showcase_jpeg_reset(); showcase_rtc_stop(); latestJPEG = nil; jpegGeneration = 0;
    configuration = nil; videoWidth = videoHeight = 0;
    haveTime = false; lastFrameAt = 0; generation++;
    for (SCBrowserClient *c in clients) {
        release_touch(c);
        if (c.role == 1) {
            discard_unsent(c); c.needsKey = true;
            uint8_t reset[5] = {3}; put_be(reset + 1, generation, 4);
            enqueue(c, websocket_packet([NSData dataWithBytes:reset length:5], 2));
        }
        if (c.role == 4) { discard_unsent(c); c.role = 3; }
    }
}
static void drop_client(SCBrowserClient *c) {
    release_touch(c);
    if (c.role == 1 || c.role == 2)
        fprintf(stderr, "[BROWSER] %s disconnected; queue=%zu bytes\n", c.role == 1 ? "media" : "control", c.queued);
    close(c.fd); [clients removeObject:c];
    if ((c.role == 1 || c.role == 4) && c.transport <= 2 && c.transport > 0) { showcase_jpeg_reset(); jpegGeneration = 0; }
    if (c.transport == 3) showcase_rtc_stop();
}
static NSData *mjpeg_part(NSData *image) {
    NSString *header = [NSString stringWithFormat:@"--showcase\r\nContent-Type: image/jpeg\r\nContent-Length: %lu\r\nX-Frame-Sequence: %llu\r\n\r\n",(unsigned long)image.length,(unsigned long long)jpegSequence];
    NSMutableData *part = [[header dataUsingEncoding:NSUTF8StringEncoding] mutableCopy]; [part appendData:image];
    [part appendBytes:"\r\n" length:2]; return part;
}
static void publish_jpeg(uint32_t stream, uint64_t micros, NSData *image) {
    pthread_mutex_lock(&browserLock);
    if (!running || !active || stream != generation || !configuration) { pthread_mutex_unlock(&browserLock); return; }
    latestJPEG = image; jpegSequence++;
    for (SCBrowserClient *c in clients) if ((c.role == 1 || c.role == 4) && (c.transport == 1 || c.transport == 2)) {
        NSData *packet;
        if (c.transport == 1) {
            uint8_t header[21] = {4}; put_be(header+1,generation,4); put_be(header+5,jpegSequence,8); put_be(header+13,micros,8);
            NSMutableData *payload = [NSMutableData dataWithBytes:header length:sizeof(header)]; [payload appendData:image];
            packet = websocket_packet(payload,2);
        } else {
            packet = mjpeg_part(image); c.lastMove = browser_now();
        }
        // Keep a partial packet plus the newest complete image. JPEG frames
        // are independently decodable; no keyframe chain needs preserving.
        if (c.output.count > 1) { discard_unsent(c); if (c.transport == 1) enqueue(c,configuration); congestionRecoveries++; }
        if (c.queued + packet.length <= MAX_QUEUE_BYTES) enqueue(c,packet);
    }
    pthread_mutex_unlock(&browserLock);
}
static void http_reply(SCBrowserClient *c, int code, NSString *mime, NSData *body) {
    NSString *h = [NSString stringWithFormat:
        @"HTTP/1.1 %d %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\n"
         "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
         "Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'\r\n"
         "Connection: close\r\n\r\n",
        code, code == 200 ? @"OK" : @"Rejected", mime, (unsigned long)body.length];
    enqueue(c, [h dataUsingEncoding:NSUTF8StringEncoding]); enqueue(c, body); c.role = 3;
}
static bool local_authority(NSString *host) {
    NSArray *parts = [host componentsSeparatedByString:@":"];
    if (parts.count != 2 || ![parts[1] isEqualToString:[NSString stringWithFormat:@"%u", listenPort]]) return false;
    struct in_addr candidate;
    if (inet_pton(AF_INET, [parts[0] UTF8String], &candidate) != 1) return false;
    struct ifaddrs *all = NULL;
    bool found = false;
    if (getifaddrs(&all) == 0) {
        for (struct ifaddrs *a = all; a; a = a->ifa_next)
            if (a->ifa_addr && a->ifa_addr->sa_family == AF_INET &&
                ((struct sockaddr_in *)a->ifa_addr)->sin_addr.s_addr == candidate.s_addr) found = true;
        freeifaddrs(all);
    }
    return found;
}
static void handle_http(SCBrowserClient *c) {
    NSData *end = [@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding];
    NSRange boundary = [c.input rangeOfData:end options:0 range:NSMakeRange(0, c.input.length)];
    if (boundary.location == NSNotFound) { if (c.input.length > 8192) drop_client(c); return; }
    NSString *text = [[NSString alloc] initWithData:[c.input subdataWithRange:NSMakeRange(0, boundary.location)] encoding:NSUTF8StringEncoding];
    NSArray *lines = [text componentsSeparatedByString:@"\r\n"];
    NSArray *request = [lines.firstObject componentsSeparatedByString:@" "];
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    bool malformed = !text || request.count != 3 || ![request[0] isEqual:@"GET"] || ![request[2] isEqual:@"HTTP/1.1"];
    for (NSUInteger i = 1; i < lines.count; i++) {
        NSRange colon = [lines[i] rangeOfString:@":"];
        if (colon.location == NSNotFound) { malformed = true; continue; }
        NSString *key = [[lines[i] substringToIndex:colon.location] lowercaseString];
        if (headers[key]) malformed = true;
        headers[key] = [[lines[i] substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    }
    if (malformed || !local_authority(headers[@"host"])) {
        http_reply(c, 400, @"text/plain", [@"Invalid request" dataUsingEncoding:NSUTF8StringEncoding]); return;
    }
    NSString *path = request[1];
    const unsigned char *asset; size_t assetLength; const char *assetMime;
    if (showcase_browser_asset(path.UTF8String,&asset,&assetLength,&assetMime)) {
        http_reply(c,200,@(assetMime),[NSData dataWithBytes:asset length:assetLength]); return;
    }
    int transport = [path isEqual:@"/jpeg"] ? 1 : [path isEqual:@"/mjpeg"] ? 2 : [path isEqual:@"/rtc"] ? 3 : 0;
    int role = ([path isEqual:@"/media"] || transport) ? 1 : [path isEqual:@"/control"] ? 2 : 0;
    if ([path isEqual:@"/status"]) {
        unsigned viewers = 0, controllers = 0; size_t queued = 0;
        for (SCBrowserClient *other in clients) {
            if (other.role == 1 || other.role == 4) { viewers++; queued += other.queued; }
            if (other.role == 2) controllers++;
        }
        NSString *owner = localPressed ? @"receiver" : @"none";
        for (SCBrowserClient *other in clients) if (other.role == 2 && other.pressed) owner = @"browser";
        NSMutableDictionary *state = [@{@"active": @(active), @"configured": @(configuration != nil), @"inputOwner": owner,
            @"width": @(videoWidth), @"height": @(videoHeight), @"generation": @(generation),
            @"version": @SHOWCASE_RELEASE_VERSION, @"build": @SHOWCASE_BUILD_NUMBER, @"receivedFrames": @(receivedFrames), @"timestampFallbacks": @(timestampFallbacks), @"viewers": @(viewers), @"controllers": @(controllers),
            @"mediaQueueBytes": @(queued), @"congestionRecoveries": @(congestionRecoveries),
            @"frameAgeMs": @(lastFrameAt ? (browser_now() - lastFrameAt) * 1000 : -1),
            @"renderers": @[@"jpeg",@"mjpeg",@"webcodecs",@"software",@"webrtc"], @"jpegSequence":@(jpegSequence),
            @"videoTimelineMicros":@(timelineMicros)} mutableCopy];
        [state addEntriesFromDictionary:showcase_jpeg_stats()]; [state addEntriesFromDictionary:showcase_rtc_stats()];
        http_reply(c, 200, @"application/json", [NSJSONSerialization dataWithJSONObject:state options:0 error:NULL]); return;
    }
    for (SCBrowserClient *other in clients) if (other != c &&
        ((role == 1 && (other.role == 1 || other.role == 4)) || (role == 2 && other.role == 2))) {
        http_reply(c,409,@"text/plain",[@"One viewer/controller at a time" dataUsingEncoding:NSUTF8StringEncoding]); return;
    }
    if (transport == 2) {
        NSString *origin = headers[@"origin"];
        if (origin && ![origin isEqual:[@"http://" stringByAppendingString:headers[@"host"]]]) {
            http_reply(c,403,@"text/plain",[@"Same origin required" dataUsingEncoding:NSUTF8StringEncoding]); return;
        }
        enqueue(c,[@"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=showcase\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nCross-Origin-Resource-Policy: same-origin\r\nConnection: keep-alive\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding]);
        c.role = 4; c.transport = 2; c.upgradePending = true; [c.input setLength:0];
        if (configuration) { jpegGeneration = generation; showcase_jpeg_configure(generation,decoderConfiguration,publish_jpeg); wantKey = true; }
        return;
    }
    NSString *origin = [@"http://" stringByAppendingString:headers[@"host"]];
    NSData *key = [[NSData alloc] initWithBase64EncodedString:headers[@"sec-websocket-key"] ?: @"" options:0];
    NSString *connection = [headers[@"connection"] lowercaseString];
    NSArray *connectionTokens = [connection componentsSeparatedByString:@","];
    bool upgrade = false;
    for (NSString *value in connectionTokens)
        if ([[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet] isEqual:@"upgrade"]) upgrade = true;
    if (!role || !upgrade || ![[headers[@"upgrade"] lowercaseString] isEqual:@"websocket"] ||
        ![headers[@"sec-websocket-version"] isEqual:@"13"] || key.length != 16 ||
        ![headers[@"origin"] isEqual:origin]) {
        http_reply(c, 403, @"text/plain", [@"Same-origin WebSocket required" dataUsingEncoding:NSUTF8StringEncoding]); return;
    }
    NSString *salted = [headers[@"sec-websocket-key"] stringByAppendingString:@"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"];
    NSData *raw = [salted dataUsingEncoding:NSUTF8StringEncoding];
    uint8_t digest[CC_SHA1_DIGEST_LENGTH]; CC_SHA1(raw.bytes, (CC_LONG)raw.length, digest);
    NSString *accept = [[NSData dataWithBytes:digest length:sizeof(digest)] base64EncodedStringWithOptions:0];
    NSString *reply = [NSString stringWithFormat:@"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %@\r\n\r\n", accept];
    enqueue(c, [reply dataUsingEncoding:NSUTF8StringEncoding]);
    c.upgradePending = true;
    c.role = role; c.needsKey = true; c.transport = transport;
    fprintf(stderr, "[BROWSER] %s connected\n", role == 1 ? "media" : "control");
    if (role == 1 && configuration) { enqueue(c, configuration); wantKey = true; }
    if (role == 1 && configuration && transport == 1) { jpegGeneration = generation; showcase_jpeg_configure(generation,decoderConfiguration,publish_jpeg); }
    if (role == 1 && configuration && transport == 3) showcase_rtc_start(generation,decoderConfiguration);
    /* HTTP pipelining and WS payload before upgrade are not supported. */
    [c.input setLength:0];
}

static bool number(NSDictionary *message, NSString *key, double *result) {
    id value = message[key];
    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return false;
    *result = [value doubleValue]; return isfinite(*result);
}
static void handle_control(SCBrowserClient *c, NSData *payload) {
    id object = [NSJSONSerialization JSONObjectWithData:payload options:0 error:NULL];
    if (![object isKindOfClass:NSDictionary.class]) { drop_client(c); return; }
    NSDictionary *message = object;
    NSString *type = message[@"type"];
    double now = browser_now();
    if ([type isEqual:@"ping"]) { c.heard = now; return; }
    if (c.role != 2) { drop_client(c); return; }
    if ([type isEqual:@"release"]) { release_touch(c); c.heard = now; return; }
    if ([type isEqual:@"keyframe"]) { wantKey = true; c.heard = now; return; }
    if ([type isEqual:@"rtc-answer"] || [type isEqual:@"rtc-candidate"]) {
        double stream;
        bool valid = number(message,@"generation",&stream) && stream == generation;
        if ([type isEqual:@"rtc-answer"]) valid = valid && [message[@"sdp"] isKindOfClass:NSString.class] && [message[@"sdp"] length] <= 24576;
        else valid = valid && [message[@"candidate"] isKindOfClass:NSString.class] && [message[@"candidate"] length] <= 2048 &&
            [message[@"mid"] isKindOfClass:NSString.class] && [message[@"mid"] length] <= 64;
        if (!valid) { drop_client(c); return; }
        showcase_rtc_signal(message); c.heard = now; return;
    }
    /* A static CarPlay screen may legitimately stop sending frames. Session
     * reset/foreground state, rather than frame age, determines input validity. */
    if (!active || !configuration) { release_touch(c); return; }
    double stream;
    if (!number(message, @"generation", &stream) || stream != generation) { release_touch(c); return; }
    if ([type isEqual:@"hold"]) { if (c.pressed) c.touched = now; c.heard = now; return; }
    double phase, x, y;
    if (![type isEqual:@"touch"] || !number(message, @"phase", &phase) ||
        !number(message, @"x", &x) || !number(message, @"y", &y) ||
        phase < 0 || phase > 3 || floor(phase) != phase ||
        x < 0 || y < 0 || x > videoWidth || y > videoHeight) { drop_client(c); return; }
    c.heard = now;
    if (phase == 0 && c.pressed) { release_touch(c); return; }
    if (phase != 0 && !c.pressed) return;
    if (phase == 0) release_local();
    if (phase == 0) { c.moveTokens = 12; c.lastMove = now; }
    if (phase == 1) {
        // TCP may deliver several healthy samples together. A small token
        // bucket preserves that path while still bounding sustained traffic.
        c.moveTokens = MIN(12.0, c.moveTokens + (now - c.lastMove) * 120);
        c.lastMove = now;
        if (c.moveTokens < 1) { c.touched = now; return; }
        c.moveTokens -= 1;
    }
    c.x = (uint16_t)llround(x); c.y = (uint16_t)llround(y); c.touched = now;
    bool sent = touchCallback && touchCallback((uint8_t)phase, c.x, c.y, 0, browser_nanos());
    if (phase == 0) c.pressed = sent;
    if (phase >= 2) c.pressed = false;
}
static void parse_websocket(SCBrowserClient *c) {
    while (c.input.length >= 2) {
        const uint8_t *p = c.input.bytes;
        uint8_t opcode = p[0] & 15;
        size_t length = p[1] & 127, header = 2;
        if ((p[0] & 0xf0) != 0x80 || !(p[1] & 128) || length == 127) { drop_client(c); return; }
        if (length == 126) {
            if (c.input.length < 4) return;
            length = ((size_t)p[2] << 8) | p[3]; header = 4;
            if (length < 126) { drop_client(c); return; }
        }
        if (length > 32768 || (opcode >= 8 && length > 125)) { drop_client(c); return; }
        if (c.input.length < header + 4 + length) return;
        const uint8_t *mask = p + header;
        NSMutableData *payload = [NSMutableData dataWithLength:length]; uint8_t *out = payload.mutableBytes;
        for (size_t i = 0; i < length; i++) out[i] = p[header + 4 + i] ^ mask[i % 4];
        [c.input replaceBytesInRange:NSMakeRange(0, header + 4 + length) withBytes:NULL length:0];
        if (opcode == 8) { drop_client(c); return; }
        if (opcode == 9) enqueue(c, websocket_packet(payload, 10));
        else if (opcode == 1) handle_control(c, payload);
        else { drop_client(c); return; }
        if (![clients containsObject:c] || c.queued > MAX_QUEUE_BYTES) { if ([clients containsObject:c]) drop_client(c); return; }
    }
}
static void *browser_loop(void *unused) {
    (void)unused;
    while (true) @autoreleasepool {
        struct pollfd fds[MAX_CLIENTS + 1];
        pthread_mutex_lock(&browserLock);
        if (!running) { pthread_mutex_unlock(&browserLock); break; }
        NSArray<SCBrowserClient *> *snapshot = [clients copy];
        fds[0] = (struct pollfd){listener, POLLIN, 0};
        for (NSUInteger i = 0; i < snapshot.count; i++)
            fds[i + 1] = (struct pollfd){snapshot[i].fd, (short)(POLLIN | (snapshot[i].output.count ? POLLOUT : 0)), 0};
        pthread_mutex_unlock(&browserLock);
        poll(fds, (nfds_t)snapshot.count + 1, 30);
        pthread_mutex_lock(&browserLock);
        if (fds[0].revents & POLLIN) {
            int fd = accept(listener, NULL, NULL);
            if (fd >= 0) {
                if (clients.count >= MAX_CLIENTS) close(fd);
                else {
                    fcntl(fd, F_SETFL, O_NONBLOCK);
                    int yes = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
                    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
                    SCBrowserClient *c = [SCBrowserClient new]; c.fd = fd; c.heard = browser_now();
                    c.input = [NSMutableData data]; c.output = [NSMutableArray array]; [clients addObject:c];
                }
            }
        }
        for (NSUInteger i = 0; i < snapshot.count; i++) {
            SCBrowserClient *c = snapshot[i];
            if (![clients containsObject:c]) continue;
            // Static screens have no new input. Refresh the same JPEG rarely
            // to keep HTTP/TLS relays alive, without incrementing frame stats.
            if (c.role == 4 && !c.output.count && latestJPEG && browser_now()-c.lastMove > 5) {
                enqueue(c,mjpeg_part(latestJPEG)); c.lastMove = browser_now();
            }
            short events = fds[i + 1].revents;
            if (events & (POLLERR | POLLHUP | POLLNVAL)) { drop_client(c); continue; }
            if (events & POLLIN) {
                uint8_t bytes[8192]; ssize_t n = recv(c.fd, bytes, sizeof(bytes), 0);
                if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) { drop_client(c); continue; }
                if (n > 0) {
                    [c.input appendBytes:bytes length:(NSUInteger)n];
                    if (c.role == 0) handle_http(c);
                    else if (c.role == 1 || c.role == 2) parse_websocket(c);
                    if (c.input.length > 32782 && [clients containsObject:c]) drop_client(c);
                }
            }
            if (![clients containsObject:c]) continue;
            /* Drain a bounded burst, rather than just 64 KiB per poll. HD IDRs
             * can span several packets; retaining framing is essential. */
            size_t budget = 512 * 1024;
            while (events & POLLOUT && c.output.count && budget) {
                NSData *packet = c.output[0];
                size_t available = packet.length - c.offset;
                ssize_t n = send(c.fd, (const uint8_t *)packet.bytes + c.offset, MIN(available, budget), 0);
                if (n <= 0) {
                    if (n < 0 && errno != EAGAIN && errno != EINTR) drop_client(c);
                    break;
                }
                if (n > 0) {
                    c.offset += (size_t)n; budget -= (size_t)n;
                    if (c.offset == packet.length) { c.queued -= packet.length; [c.output removeObjectAtIndex:0]; c.offset = 0; c.upgradePending = false; }
                }
            }
            if (![clients containsObject:c]) continue;
            double now = browser_now();
            if (c.pressed && now - c.touched > 0.75) release_touch(c);
            if ((c.role == 3 && c.output.count == 0) || (c.role != 4 && now - c.heard > ((c.role == 0 || c.role == 3) ? 5 : 20))) drop_client(c);
        }
        for (NSDictionary *event in showcase_rtc_events()) {
            if ([event[@"generation"] unsignedIntValue] != generation) continue;
            if ([event[@"type"] isEqual:@"rtc-keyframe"]) wantKey = true;
            else for (SCBrowserClient *c in clients) if (c.role == 1 && c.transport == 3)
                enqueue(c,websocket_packet([NSJSONSerialization dataWithJSONObject:event options:0 error:NULL],1));
        }
        bool request = wantKey && active && browser_now() - lastKeyAt >= 2;
        if (request) { wantKey = false; lastKeyAt = browser_now(); }
        pthread_mutex_unlock(&browserLock);
        if (request && resyncCallback) resyncCallback();
    }
    return NULL;
}

bool showcase_browser_start(uint16_t port, ShowcaseBrowserTouch touch,
                            ShowcaseBrowserResync resync) {
    if (!port) return false;
    pthread_mutex_lock(&browserLock);
    if (running) { pthread_mutex_unlock(&browserLock); return false; }
    listener = socket(AF_INET, SOCK_STREAM, 0);
    int yes = 1; setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in address = {0}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY); address.sin_port = htons(port);
    if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 8)) {
        if (listener >= 0) close(listener); listener = -1;
        pthread_mutex_unlock(&browserLock); return false;
    }
    fcntl(listener, F_SETFL, O_NONBLOCK);
    listenPort = port;
    touchCallback = touch; resyncCallback = resync;
    clients = [NSMutableArray array]; active = true; running = true;
    receivedFrames = timestampFallbacks = congestionRecoveries = 0;
    decoderConfiguration = nil;
    invalidate_stream();
    int error = pthread_create(&browserThread, NULL, browser_loop, NULL);
    if (error) { running = false; close(listener); listener = -1; }
    pthread_mutex_unlock(&browserLock);
    return error == 0;
}
void showcase_browser_stop(void) {
    pthread_mutex_lock(&browserLock);
    bool wasRunning = running; running = false;
    pthread_mutex_unlock(&browserLock);
    if (!wasRunning) return;
    pthread_join(browserThread, NULL);
    pthread_mutex_lock(&browserLock);
    release_local();
    for (SCBrowserClient *c in [clients copy]) drop_client(c);
    close(listener); listener = -1; clients = nil; configuration = nil; decoderConfiguration = nil;
    pthread_mutex_unlock(&browserLock);
    showcase_jpeg_stop(); showcase_rtc_stop();
}
void showcase_browser_set_active(bool value) {
    pthread_mutex_lock(&browserLock);
    bool previous = active;
    active = value;
    if (!value && previous) {
        /* Visibility does not tear down the CarPlay screen connection. A
         * resume often sends only an IDR, without another VideoConfig. */
        uint16_t width = videoWidth, height = videoHeight;
        invalidate_stream(); videoWidth = width; videoHeight = height;
    }
    if (value && !previous && !configuration && decoderConfiguration && videoWidth && videoHeight) {
        uint8_t header[9] = {1}; put_be(header+1,generation,4);
        put_be(header+5,videoWidth,2); put_be(header+7,videoHeight,2);
        NSMutableData *payload = [NSMutableData dataWithBytes:header length:sizeof(header)];
        [payload appendData:decoderConfiguration]; configuration = websocket_packet(payload,2);
        for (SCBrowserClient *c in clients) if (c.role == 1) {
            c.needsKey = true; enqueue(c,configuration);
            if (c.transport == 1) { jpegGeneration=generation; showcase_jpeg_configure(generation,decoderConfiguration,publish_jpeg); }
            if (c.transport == 3) showcase_rtc_start(generation,decoderConfiguration);
        }
        wantKey = true;
    }
    pthread_mutex_unlock(&browserLock);
}
void showcase_browser_reset(void) {
    pthread_mutex_lock(&browserLock); invalidate_stream(); pthread_mutex_unlock(&browserLock);
}
static bool valid_avcc(const uint8_t *bytes, size_t length) {
    if (!bytes || length < 7 || length > 65536 || bytes[0] != 1 || (bytes[4] & 3) != 3) return false;
    size_t at = 6;
    unsigned sps = bytes[5] & 31;
    if (!sps) return false;
    for (unsigned group = 0; group < 2; group++) {
        unsigned count = group ? (at < length ? bytes[at++] : 0) : sps;
        if (!count) return false;
        for (unsigned n = 0; n < count; n++) {
            if (at + 2 > length) return false;
            size_t size = ((size_t)bytes[at] << 8) | bytes[at + 1]; at += 2;
            if (!size || size > length - at || (bytes[at] & 31) != (group ? 8 : 7)) return false;
            at += size;
        }
    }
    return true;
}
void showcase_browser_config(uint16_t width, uint16_t height, const uint8_t *avcc, size_t length) {
    if (!width || !height || width > 4096 || height > 4096 || !valid_avcc(avcc, length)) return;
    pthread_mutex_lock(&browserLock);
    NSData *incoming = [NSData dataWithBytes:avcc length:length];
    /* Senders may repeat SPS/PPS at an IDR. That is not a new stream and
     * must not clear the browser or change the touch generation. */
    if (configuration && width == videoWidth && height == videoHeight && [incoming isEqualToData:decoderConfiguration]) {
        pthread_mutex_unlock(&browserLock); return;
    }
    invalidate_stream(); videoWidth = width; videoHeight = height;
    decoderConfiguration = incoming;
    fprintf(stderr, "[BROWSER] stream generation=%u size=%ux%u\n", generation, width, height);
    uint8_t header[9] = {1}; put_be(header + 1, generation, 4);
    put_be(header + 5, width, 2); put_be(header + 7, height, 2);
    NSMutableData *payload = [NSMutableData dataWithBytes:header length:sizeof(header)];
    [payload appendBytes:avcc length:length]; configuration = websocket_packet(payload, 2);
    for (SCBrowserClient *c in clients) if (c.role == 1) {
        enqueue(c, configuration);
        if (c.transport == 1) { jpegGeneration = generation; showcase_jpeg_configure(generation,decoderConfiguration,publish_jpeg); }
        if (c.transport == 3) showcase_rtc_start(generation,decoderConfiguration);
    }
    wantKey = true;
    pthread_mutex_unlock(&browserLock);
}
void showcase_browser_frame(uint64_t timestamp, bool key, const uint8_t *bytes, size_t length) {
    if (!bytes || !length || length > MAX_FRAME_BYTES) return;
    size_t offset = 0;
    while (offset + 4 < length) {
        uint32_t size = ((uint32_t)bytes[offset] << 24) | ((uint32_t)bytes[offset+1] << 16) |
            ((uint32_t)bytes[offset+2] << 8) | bytes[offset+3]; offset += 4;
        if (!size || size > length - offset) return;
        offset += size;
    }
    if (offset != length) return;
    pthread_mutex_lock(&browserLock);
    if (!running || !active || !configuration) { pthread_mutex_unlock(&browserLock); return; }
    bool watching = false;
    bool jpegWatching = false, rtcWatching = false;
    for (SCBrowserClient *c in clients) if (c.role == 1 || c.role == 4) {
        watching = true; jpegWatching |= c.transport == 1 || c.transport == 2; rtcWatching |= c.transport == 3;
    }
    lastFrameAt = browser_now(); receivedFrames++;
    if (!watching) { pthread_mutex_unlock(&browserLock); return; }
    double arrival = browser_now();
    uint64_t step = 0;
    if (haveTime) {
        if (timestamp && lastTime && timestamp > lastTime)
            step = (uint64_t)((long double)(timestamp - lastTime) * 1000000.0L / 4294967296.0L);
        if (!step || step > 250000) {
            /* Some senders don't supply usable presentation times. Dropping
             * them froze the browser while the native renderer kept working.
             * Decode order is preserved; B slices are rejected by the player. */
            double elapsed = (arrival - lastArrival) * 1000000.0;
            step = elapsed > 0 && elapsed <= 250000 ? (uint64_t)elapsed : 33333;
            if (!step) step = 1;
            timestampFallbacks++;
        }
        timelineMicros += step;
    } else { timelineMicros = 0; haveTime = true; }
    lastTime = timestamp; lastArrival = arrival;
    uint64_t micros = timelineMicros;
    NSData *input = [NSData dataWithBytes:bytes length:length];
    if (jpegWatching) {
        if (jpegGeneration != generation) { jpegGeneration = generation; showcase_jpeg_configure(generation,decoderConfiguration,publish_jpeg); }
        if (!showcase_jpeg_frame(generation,micros,key,input)) wantKey = true;
    }
    if (rtcWatching) showcase_rtc_frame(generation,micros,key,input);
    uint8_t header[14] = {2}; put_be(header + 1, generation, 4); header[5] = key ? 1 : 0;
    put_be(header + 6, micros, 8);
    NSMutableData *payload = [NSMutableData dataWithBytes:header length:sizeof(header)];
    [payload appendBytes:bytes length:length]; NSData *packet = websocket_packet(payload, 2);
    for (SCBrowserClient *c in clients) if (c.role == 1 && c.transport == 0) {
        if (c.queued + packet.length > MAX_QUEUE_BYTES || c.output.count >= 45) {
            discard_unsent(c); c.needsKey = true; enqueue(c, configuration); wantKey = true;
            congestionRecoveries++;
        }
        if (c.needsKey && !key) continue;
        if (c.queued + packet.length > MAX_QUEUE_BYTES) { c.needsKey = true; wantKey = true; continue; }
        c.needsKey = false; enqueue(c, packet);
    }
    pthread_mutex_unlock(&browserLock);
}
bool showcase_browser_local_touch(uint8_t phase, uint16_t x, uint16_t y,
                                  uint8_t contact, uint64_t hostNanos) {
    pthread_mutex_lock(&browserLock);
    if (!running || !active || !configuration || phase > 3 || x > videoWidth || y > videoHeight) {
        release_local(); pthread_mutex_unlock(&browserLock); return false;
    }
    if (phase == 0) {
        release_local();
        for (SCBrowserClient *c in clients) if (c.role == 2) release_touch(c);
    } else if (!localPressed) { pthread_mutex_unlock(&browserLock); return false; }
    localX = x; localY = y;
    bool sent = touchCallback && touchCallback(phase, x, y, contact, hostNanos ?: browser_nanos());
    if (phase == 0) localPressed = sent;
    if (phase >= 2) localPressed = false;
    pthread_mutex_unlock(&browserLock); return sent;
}
