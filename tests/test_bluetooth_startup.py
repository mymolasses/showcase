"""Exercise production readiness waiting with real children and sentinel files.

No Bluetooth hardware or launchd jobs are touched. A ready helper must release
startup promptly, while an exited helper must not be accepted via a stale file.
"""
from pathlib import Path
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'source/Showcase.m').read_text()
start = source.index('static BOOL wait_for_bt_ready_or_exit(')
function = source[start:source.index('static BOOL wait_for_pid_alive(', start)]
flow = source[source.index('- (void)bgPrepareBT {'):source.index('- (BOOL)startBTstackDaemon:')]
assert 'wait_for_pid_alive(self.carplayBtPid' not in flow, 'Fixed survival wait delays network handoff'

harness = r'''
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
typedef bool BOOL;
#define YES true
#define NO false
#define BT_READY_PATH "ready"
static char last_log[512];
static void ip_log(const char *format, ...) {
    va_list args; va_start(args, format);
    vsnprintf(last_log, sizeof(last_log), format, args); va_end(args);
}
static BOOL pid_alive(pid_t pid) { return kill(pid, 0) == 0; }
''' + function + r'''
static double now(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static void sentinel(void) {
    int fd = open(BT_READY_PATH, O_CREAT | O_WRONLY, 0600);
    assert(fd >= 0); close(fd);
}
static pid_t helper(bool ready) {
    pid_t pid = fork(); assert(pid >= 0);
    if (!pid) {
        if (ready) { usleep(120000); sentinel(); }
        for (;;) pause();
    }
    return pid;
}
static void reap(pid_t pid) {
    kill(pid, SIGKILL); assert(waitpid(pid, NULL, 0) == pid);
}
static void wait_for_zombie(pid_t pid) {
    siginfo_t result;
    assert(waitid(P_PID, pid, &result, WEXITED | WNOWAIT) == 0);
}
int main(void) {
    unlink(BT_READY_PATH);
    pid_t pid = helper(true);
    double started = now();
    assert(wait_for_bt_ready_or_exit(pid, 2));
    assert(now() - started < 1.0); // Not the previous eight-second delay.
    reap(pid);

    // A ready file left by a child which exited is not hardware readiness.
    pid = fork(); assert(pid >= 0);
    if (!pid) _exit(62);
    wait_for_zombie(pid);
    assert(!wait_for_bt_ready_or_exit(pid, 2));
    assert(strstr(last_log, "POWERON_FAILED (62)"));

    unlink(BT_READY_PATH);
    pid = helper(false);
    started = now();
    assert(!wait_for_bt_ready_or_exit(pid, 1));
    assert(now() - started >= 0.9 && now() - started < 2.0);
    assert(strstr(last_log, "timeout"));
    reap(pid);

    pid = fork(); assert(pid >= 0);
    if (!pid) { raise(SIGTERM); _exit(1); }
    wait_for_zombie(pid);
    assert(!wait_for_bt_ready_or_exit(pid, 2));
    assert(strstr(last_log, "signal="));
    puts("PASS: ready without survival delay, exited helper with stale ready file, timeout, signal");
}
'''
with tempfile.TemporaryDirectory(prefix='showcase-bt-startup-') as directory:
    root = Path(directory)
    (root / 'startup.c').write_text(harness)
    subprocess.run(['clang', str(root / 'startup.c'), '-o', str(root / 'startup')], check=True)
    subprocess.run([str(root / 'startup')], cwd=root, check=True, timeout=10)
