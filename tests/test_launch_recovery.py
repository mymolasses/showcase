"""Real stalled helper/socket regression, without iOS private services."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'source/Showcase.m').read_text()
start = source.index('static int wait_child_bounded(')
function = source[start:source.index('static NSData *capture_process_output(', start)]
harness = r'''
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "baa_broker.h"
#define NSEC_PER_SEC 1000000000ULL
static uint64_t monotonic_nanos_now(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t);
    return t.tv_sec*NSEC_PER_SEC+t.tv_nsec;
}
''' + function + r'''
int main(void) {
    signal(SIGPIPE,SIG_IGN);
    pid_t pid = fork(); assert(pid >= 0);
    if (!pid) _exit(7);
    int status = wait_child_bounded(pid,1000);
    assert(status >= 0 && WIFEXITED(status) && WEXITSTATUS(status)==7);
    pid = fork(); assert(pid >= 0);
    if (!pid) { signal(SIGTERM,SIG_IGN); for (;;) pause(); }
    uint64_t start = monotonic_nanos_now();
    assert(wait_child_bounded(pid,150)==-1 && errno==ETIMEDOUT);
    assert(monotonic_nanos_now()-start < NSEC_PER_SEC);
    assert(waitpid(pid,NULL,WNOHANG)==-1 && errno==ECHILD);
    // A client killed halfway through its header must not hold the broker.
    int sockets[2]; assert(socketpair(AF_UNIX,SOCK_STREAM,0,sockets)==0);
    assert(baa_socket_timeout(sockets[0]));
    assert(write(sockets[1],"BAA",3)==3);
    uint8_t header[12]; start=monotonic_nanos_now();
    assert(!baa_read_exact(sockets[0],header,sizeof(header)));
    assert(monotonic_nanos_now()-start < 4*NSEC_PER_SEC);
    close(sockets[0]); close(sockets[1]);
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,sockets)==0);
    assert(baa_socket_timeout(sockets[0]));
    baa_make_header(header,BAA_OP_GET_CERTS,0,0);
    assert(baa_write_exact(sockets[1],header,sizeof(header)));
    uint8_t received[12]; assert(baa_read_exact(sockets[0],received,sizeof(received)));
    assert(memcmp(header,received,sizeof(header))==0);
    close(sockets[0]); close(sockets[1]);
    puts("PASS: normal child, stalled child killed/reaped, partial BAA request timeout, healthy request");
}
'''
with tempfile.TemporaryDirectory(prefix='showcase-launch-') as directory:
    work = Path(directory)
    (work / 'launch.c').write_text(harness)
    subprocess.run(['clang', '-I', str(root / 'source'), str(work / 'launch.c'), '-o', str(work / 'launch')], check=True)
    subprocess.run([str(work / 'launch')], check=True, timeout=10)
