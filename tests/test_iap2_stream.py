"""Replay the reported coalesced handoff through the production iAP2 receiver.

Synthetic messages preserve packet lengths/sequence numbers from the trace;
no phone identifiers, certificates, challenges or hotspot secrets are fixtures.
No Bluetooth hardware is used.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'source/carplay_bt.m').read_text(encoding='utf-8')
start = source.index('static void receive_iap2_packet(')
receiver = source[start:source.index('/* ═', start)]
harness = r'''
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "iap2_stream.h"
#define usleep(x) ((void)(x))
#define alarm(x) ((void)(x))
static int iap2_detected, link_established;
static uint8_t my_initial_psn, my_next_psn, peer_psn;
static uint8_t iap2_detect[] = {0xff,0x55,2,0,0xee,0x10};
static unsigned ack_count, syn_count, count;
static uint16_t messages[100];
static void send_ack(void) { ack_count++; }
static void send_syn(void) { syn_count++; }
static void handle_ctrl_msg(uint16_t mid, uint8_t *params, int length) {
    (void)params; assert(length >= 0); assert(count < 100); messages[count++] = mid;
}
''' + receiver + r'''
static SCIAP2Stream stream;
static uint8_t batch[4096];
static uint8_t checksum(uint8_t *p, size_t n) {
    uint8_t v=0; for(size_t i=0;i<n;i++) v+=p[i]; return (uint8_t)-v;
}
static size_t frame(uint8_t *p, uint8_t seq, uint8_t session, uint16_t mid, size_t parameters) {
    size_t n=session ? 16+parameters : 9;
    memset(p,0,n); p[0]=0xff; p[1]=0x5a; p[2]=n>>8; p[3]=n;
    p[4]=0x40; p[5]=seq; p[6]=0x9c; p[7]=session; p[8]=checksum(p,8);
    if(session) {
        p[9]=p[10]=0x40; p[11]=(6+parameters)>>8; p[12]=6+parameters;
        p[13]=mid>>8; p[14]=mid; p[n-1]=checksum(p+9,n-10);
    }
    return n;
}
static void reset(void) {
    stream.used=0; count=ack_count=syn_count=0;
    peer_psn=0xfa; link_established=1; iap2_detected=1;
}
static void feed(uint8_t *p,size_t n) { sc_iap2_feed(&stream,p,n,receive_iap2_packet,NULL); }
static void check_handoff(void) {
    const uint16_t expected[]={0xaa05,0x5702,0x4e0b,0x4e0d,0x4e0e};
    assert(count==5 && ack_count==5 && peer_psn==0xff && stream.used==0);
    assert(!memcmp(messages,expected,sizeof(expected)));
}
static size_t received_size;
static void collect(uint8_t *p,size_t n,void *ctx) { (void)p; (void)ctx; received_size=n; }
int main(void) {
    /* 18:14:43.425: all five iAP2 messages in one 159-byte RFCOMM payload. */
    const uint16_t ids[]={0xaa05,0x5702,0x4e0b,0x4e0d,0x4e0e};
    const size_t params[]={0,0,23,5,51};
    size_t used=0;
    for(unsigned i=0;i<5;i++) used+=frame(batch+used,0xfb+i,1,ids[i],params[i]);
    assert(used==159);
    reset(); feed(batch,used); check_handoff();
    /* Every split position, including inside length/checksum/control fields. */
    for(size_t split=0;split<=used;split++) {
        reset(); feed(batch,split); feed(batch+split,used-split); check_handoff();
    }
    reset(); for(size_t i=0;i<used;i++) feed(batch+i,1); check_handoff();

    uint8_t next[100]; size_t n=frame(next,0,1,0x5702,0);
    feed(next,n); assert(count==6 && peer_psn==0); // FF -> 00 wrap
    feed(next,n); assert(count==6 && ack_count==7); // retry ACK, no duplicate config
    n=frame(next,0x55,0,0,0); feed(next,n); assert(peer_psn==0); // ACK doesn't advance data
    n=frame(next,2,1,0x4e0e,0); feed(next,n); assert(count==6 && peer_psn==0); // gap
    n=frame(next,1,1,0x4e0d,0); feed(next,n); assert(count==7 && peer_psn==1);

    /* Corruption must not reach control handling or prevent the next valid frame. */
    reset(); n=frame(next,0xfb,1,0xaa05,0); next[n-1]^=1;
    feed(next,n); assert(!count);
    memset(next,0x33,sizeof(next)); feed(next,sizeof(next)); assert(!count);
    n=frame(next,0xfb,1,0xaa05,0); feed(next,n); assert(count==1);
    /* Valid outer checksum but impossible inner length: bounded rejection. */
    reset(); n=frame(next,0xfb,1,0xaa05,0); next[11]=0xff; next[12]=0xff;
    next[n-1]=checksum(next+9,n-10); feed(next,n); assert(!count);
    reset(); n=frame(next,0xfb,1,0xaa05,0); next[12]=5;
    next[n-1]=checksum(next+9,n-10); feed(next,n); assert(!count);

    /* Partial state belongs to one RFCOMM connection. */
    reset(); feed(batch,12); assert(!count && stream.used==12);
    stream.used=0; feed(batch,used); check_handoff();
    reset(); iap2_detected=0; link_established=0;
    for(size_t i=0;i<sizeof(iap2_detect);i++) feed(iap2_detect+i,1);
    assert(iap2_detected && syn_count==1);

    /* Largest representable frame and input larger than the bounded buffer. */
    uint8_t *large=malloc(65535); assert(large);
    frame(large,0,1,0x4e0b,65535-16);
    stream.used=0; received_size=0;
    sc_iap2_feed(&stream,large,65534,collect,NULL); assert(!received_size);
    sc_iap2_feed(&stream,large+65534,1,collect,NULL); assert(received_size==65535 && !stream.used);
    memset(large,0x11,65535);
    sc_iap2_feed(&stream,large,65535,collect,NULL);
    sc_iap2_feed(&stream,batch,used,collect,NULL); assert(received_size==67 && !stream.used);
    free(large);
    puts("PASS: coalesced Wi-Fi handoff, every split, byte stream, sequence wrap, duplicates, ACK, corruption and bounds");
}
'''
with tempfile.TemporaryDirectory(prefix='showcase-iap2-') as directory:
    work = Path(directory)
    (work / 'test.c').write_text(harness, encoding='utf-8')
    compiler = os.environ.get('CC') or shutil.which('clang') or shutil.which('gcc')
    assert compiler, 'A C compiler is required'
    target = work / ('test.exe' if os.name == 'nt' else 'test')
    subprocess.run([compiler, '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(root/'source'),
                    str(work/'test.c'), '-o', str(target)], check=True)
    result = subprocess.run([str(target)], text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    print(result.stdout.splitlines()[-1])
