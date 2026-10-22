/* SPDX-License-Identifier: GPL-3.0-or-later
 * Independent foreground-session network probe. The single-threaded C child
 * owns alias transactions and cleans up when this helper's channel closes.
 */
#import <Foundation/Foundation.h>
#include <TargetConditionals.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include "browser_network.h"
#include "browser_settings.h"
#include "browser_assets.h"

static volatile sig_atomic_t stopped;
static void stop_signal(int value) { (void)value; stopped = 1; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static NSString *ip(uint32_t address) {
    if (!address) return @"";
    char buffer[INET_ADDRSTRLEN]; struct in_addr a = {address};
    return inet_ntop(AF_INET, &a, buffer, sizeof(buffer)) ? [NSString stringWithUTF8String:buffer] : @"";
}
static int listener(uint16_t port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0), yes = 1;
    if (fd < 0) return -1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in a = {0}; a.sin_len = sizeof(a); a.sin_family = AF_INET; a.sin_port = htons(port);
    if (bind(fd, (struct sockaddr *)&a, sizeof(a)) || listen(fd, 8)) { int error = errno; close(fd); errno = error; return -1; }
    fcntl(fd, F_SETFL, O_NONBLOCK); fcntl(fd, F_SETFD, FD_CLOEXEC); return fd;
}
@interface SCProbeClient : NSObject
@property int fd;
@property uint16_t port;
@property uint32_t peer, local;
@property double started;
@property size_t sent;
@property (nonatomic, strong) NSMutableData *input;
@property (nonatomic, strong) NSData *output;
@end
@implementation SCProbeClient
@end
static NSDictionary *report(SCNetState *s, bool port80, uint16_t port, uint64_t requests, uint64_t tls) {
    return @{@"version": @"Browser3", @"pid": @(getpid()), @"parentPid": @(getppid()),
        @"updated": @(NSDate.date.timeIntervalSince1970), @"localReady": @(s->ready),
        @"phase": [NSString stringWithUTF8String:s->phase], @"detail": [NSString stringWithUTF8String:s->detail],
        @"interface": [NSString stringWithUTF8String:s->primary.name], @"hotspotAddress": ip(s->primary.address),
        @"compatibilityAddress": @SC_COMPAT_IP, @"port80": @(port80), @"probePort": @(port),
        @"probeRequests": @(requests), @"tlsOnHTTP": @(tls)};
}
static void reply(SCProbeClient *c, int code, NSString *mime, NSData *body) {
    NSString *header = [NSString stringWithFormat:@"HTTP/1.1 %d %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'\r\n\r\n",
        code, code == 200 ? @"OK" : @"Rejected", mime, (unsigned long)body.length];
    NSMutableData *output = [[header dataUsingEncoding:NSUTF8StringEncoding] mutableCopy]; [output appendData:body]; c.output = output;
}
static bool authority(NSString *host, uint32_t local, uint16_t port) {
    NSString *address = ip(local);
    return [host isEqualToString:[NSString stringWithFormat:@"%@:%u", address, port]] || (port == 80 && [host isEqualToString:address]);
}
static bool allowed(uint32_t peer, SCNetState *state) {
    return ntohl(peer) >> 24 == 127 || (state->primary.mask &&
        (peer & state->primary.mask) == (state->primary.address & state->primary.mask));
}
static bool tick(int channel, SCNetState *state) {
    char command = 'T'; if (write(channel, &command, 1) != 1) return false;
    char *bytes = (char *)state; size_t at = 0;
    while (at < sizeof(*state)) {
        struct pollfd p = {channel, POLLIN, 0};
        if (poll(&p, 1, 1800) <= 0) return false;
        ssize_t n = read(channel, bytes + at, sizeof(*state) - at);
        if (n <= 0) return false; at += (size_t)n;
    }
    return true;
}
int main(int argc, char **argv) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0); setvbuf(stderr, NULL, _IOLBF, 0);
    pid_t parent = 0; uint16_t port = BROWSER_PROBE_PORT;
    NSString *statePath = BROWSER_PROBE_STATE;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--parent") && i + 1 < argc) parent = (pid_t)atoi(argv[++i]);
#ifdef SC_PROBE_TEST
        else if (!strcmp(argv[i], "--test-state") && i + 1 < argc) statePath = [NSString stringWithUTF8String:argv[++i]];
        else if (!strcmp(argv[i], "--test-port") && i + 1 < argc) port = (uint16_t)atoi(argv[++i]);
#endif
        else { fprintf(stderr, "Unknown argument\n"); return 2; }
    }
    if (parent <= 1 || getppid() != parent) { fprintf(stderr, "Parent process mismatch\n"); return 2; }
#ifndef SC_PROBE_TEST
    if (geteuid() != 0 || !TARGET_OS_IPHONE || TARGET_OS_SIMULATOR) { fprintf(stderr, "Requires jailbroken iOS root helper\n"); return 3; }
    setuid(0); setgid(0);
#endif
    [[NSFileManager defaultManager] createDirectoryAtPath:statePath.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    NSString *lockPath = [statePath stringByAppendingString:@".lock"];
    int lock = open(lockPath.fileSystemRepresentation, O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB)) { fprintf(stderr, "Network probe already running or lock unavailable\n"); if (lock >= 0) close(lock); return 4; }
    signal(SIGPIPE, SIG_IGN); signal(SIGTERM, stop_signal); signal(SIGINT, stop_signal);
    int ports[2] = {listener(port), -1};
    if (ports[0] < 0) { fprintf(stderr, "Probe port %u unavailable: %s\n", port, strerror(errno)); close(lock); return 5; }
#ifndef SC_PROBE_TEST
    ports[1] = listener(80);
    if (ports[1] < 0) fprintf(stderr, "[TESLA-NET] port 80 unavailable: %s; using %u\n", strerror(errno), port);
#endif
    int channel[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, channel)) return 6;
    pid_t guard = fork();
    if (guard < 0) return 7;
    if (guard == 0) {
        close(channel[0]); close(ports[0]); if (ports[1] >= 0) close(ports[1]);
        SCNetOps ops = sc_network_darwin_ops();
        int rc = sc_network_guard(channel[1], &ops); close(lock); _exit(rc);
    }
    close(channel[1]);
    SCNetState state = {0}; bool port80 = ports[1] >= 0;
    NSMutableArray<SCProbeClient *> *clients = [NSMutableArray array];
    uint64_t requests = 0, tls = 0; double nextTick = 0;
    fprintf(stderr, "[TESLA-NET] probe HTTP ports=%u%s guard=%d; no CarPlay session required\n", port, port80 ? ",80" : "", guard);
    while (!stopped && getppid() == parent) { @autoreleasepool {
        if (now() >= nextTick) {
            char previous[sizeof(state.detail)]; snprintf(previous, sizeof(previous), "%s", state.detail);
            if (!tick(channel[0], &state)) { fprintf(stderr, "[TESLA-NET] guard channel failed\n"); break; }
            if (strcmp(previous, state.detail)) fprintf(stderr, "[TESLA-NET] phase=%s interface=%s detail=%s\n", state.phase, state.primary.name, state.detail);
            NSData *json = [NSJSONSerialization dataWithJSONObject:report(&state, port80, port, requests, tls) options:NSJSONWritingPrettyPrinted error:NULL];
            [json writeToFile:statePath options:NSDataWritingAtomic error:NULL]; chmod(statePath.fileSystemRepresentation, 0644);
            nextTick = now() + 1;
        }
        NSArray<SCProbeClient *> *snapshot = [clients copy]; struct pollfd fds[10];
        fds[0] = (struct pollfd){ports[0], POLLIN, 0}; fds[1] = (struct pollfd){ports[1], POLLIN, 0};
        for (NSUInteger i = 0; i < snapshot.count; i++) fds[i+2] = (struct pollfd){snapshot[i].fd, snapshot[i].output ? POLLOUT : POLLIN, 0};
        if (poll(fds, (nfds_t)snapshot.count + 2, 100) < 0 && errno != EINTR) break;
        for (int i = 0; i < 2; i++) if (fds[i].revents & POLLIN) {
            struct sockaddr_in peer = {0}, local = {0}; socklen_t length = sizeof(peer);
            int fd = accept(ports[i], (struct sockaddr *)&peer, &length);
            if (fd < 0) continue;
            if (clients.count >= 8 || !allowed(peer.sin_addr.s_addr, &state)) { close(fd); continue; }
            length = sizeof(local); getsockname(fd, (struct sockaddr *)&local, &length);
            fcntl(fd, F_SETFL, O_NONBLOCK); int yes = 1;
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes)); setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
            SCProbeClient *c = [SCProbeClient new]; c.fd = fd; c.port = ntohs(local.sin_port); c.local = local.sin_addr.s_addr;
            c.peer = peer.sin_addr.s_addr; c.started = now(); c.input = [NSMutableData data]; [clients addObject:c];
        }
        for (NSUInteger i = 0; i < snapshot.count; i++) {
            SCProbeClient *c = snapshot[i]; short events = fds[i+2].revents;
            bool remove = now() - c.started > 5 || (events & (POLLHUP | POLLERR | POLLNVAL));
            if (!remove && (events & POLLIN)) {
                uint8_t bytes[4096]; ssize_t n = recv(c.fd, bytes, sizeof(bytes), 0);
                if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) remove = true;
                if (n > 0) [c.input appendBytes:bytes length:(NSUInteger)n];
                if (c.input.length && ((const uint8_t *)c.input.bytes)[0] == 0x16) {
                    tls++; fprintf(stderr, "[TESLA-NET] TLS arrived on HTTP port %u\n", c.port); remove = true;
                }
                NSData *end = [@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding];
                NSRange boundary = [c.input rangeOfData:end options:0 range:NSMakeRange(0, c.input.length)];
                if (!remove && boundary.location != NSNotFound) {
                    NSString *text = [[NSString alloc] initWithData:[c.input subdataWithRange:NSMakeRange(0, boundary.location)] encoding:NSUTF8StringEncoding];
                    NSArray *lines = [text componentsSeparatedByString:@"\r\n"], *request = [lines.firstObject componentsSeparatedByString:@" "];
                    NSMutableDictionary *headers = [NSMutableDictionary dictionary]; bool valid = request.count == 3 && [request[0] isEqual:@"GET"] && [request[2] isEqual:@"HTTP/1.1"];
                    for (NSUInteger k = 1; k < lines.count; k++) {
                        NSRange colon = [lines[k] rangeOfString:@":"];
                        if (colon.location == NSNotFound) { valid = false; continue; }
                        NSString *key = [[lines[k] substringToIndex:colon.location] lowercaseString];
                        if (headers[key]) valid = false;
                        headers[key] = [[lines[k] substringFromIndex:colon.location+1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
                    }
                    valid = valid && authority(headers[@"host"], c.local, c.port);
                    NSString *path = request.count > 1 ? request[1] : @"";
                    if (!valid) reply(c, 400, @"text/plain", [@"Invalid local HTTP request" dataUsingEncoding:NSUTF8StringEncoding]);
                    else if ([path isEqual:@"/"] || [path isEqual:@"/probe"] || [path isEqual:@"/probe.js"]) {
                        bool script = [path isEqual:@"/probe.js"]; const char *asset = script ? browser_probe_js : browser_probe_html;
                        if (!script) { requests++; fprintf(stderr, "[TESLA-NET] HTTP probe received port=%u\n", c.port); }
                        reply(c, 200, script ? @"application/javascript" : @"text/html; charset=utf-8", [NSData dataWithBytes:asset length:strlen(asset)]);
                    } else if ([path isEqual:@"/probe.json"]) {
                        requests++; NSMutableDictionary *data = [report(&state, port80, port, requests, tls) mutableCopy];
                        SCNetRoute route = {0}; int error = sc_network_route(c.peer, &route); char name[IFNAMSIZ] = "";
                        if (!error) if_indextoname(route.index, name);
                        data[@"returnInterface"] = [NSString stringWithUTF8String:name];
                        data[@"returnViaHotspot"] = @(!error && state.primary.index && route.index == state.primary.index);
                        reply(c, 200, @"application/json", [NSJSONSerialization dataWithJSONObject:data options:0 error:NULL]);
                    } else reply(c, 404, @"text/plain", [@"Not found" dataUsingEncoding:NSUTF8StringEncoding]);
                }
                if (c.input.length > 8192) remove = true;
            }
            if (!remove && (events & POLLOUT) && c.output) {
                ssize_t n = send(c.fd, (const uint8_t *)c.output.bytes + c.sent, c.output.length - c.sent, 0);
                if (n > 0) c.sent += (size_t)n;
                else if (n == 0 || (errno != EINTR && errno != EAGAIN)) remove = true;
                if (c.sent == c.output.length) remove = true;
            }
            if (remove) { close(c.fd); [clients removeObject:c]; }
        }
    } }
    for (SCProbeClient *c in clients) close(c.fd);
    close(ports[0]); if (ports[1] >= 0) close(ports[1]);
    close(channel[0]); /* EOF makes the guard clean up even after SIGKILL here. */
    int status = -1;
    while (waitpid(guard, &status, 0) < 0 && errno == EINTR) {}
    state.ready = false; snprintf(state.phase, sizeof(state.phase), "%s", WIFEXITED(status) && WEXITSTATUS(status) == 0 ? "stopped" : "cleanup_failed");
    snprintf(state.detail, sizeof(state.detail), "%s", "Network probe stopped; inspect network-probe.log if cleanup failed");
    NSData *json = [NSJSONSerialization dataWithJSONObject:report(&state, false, port, requests, tls) options:0 error:NULL];
    [json writeToFile:statePath options:NSDataWritingAtomic error:NULL];
    close(lock); return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
} }
