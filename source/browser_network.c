/* SPDX-License-Identifier: GPL-3.0-or-later
 * Darwin IPv4 alias transaction. /32 alias creation installs the kernel's
 * local host route; existing hotspot/DHCP/default routes are never replaced.
 */
#include "browser_network.h"
#include <TargetConditionals.h>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sockio.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

static void result(SCNetState *s, const char *phase, const char *text, int error) {
    s->ready = !strcmp(phase, "local_ready");
    snprintf(s->phase, sizeof(s->phase), "%s", phase);
    if (error) snprintf(s->detail, sizeof(s->detail), "%s: %s (%d)", text, strerror(error), error);
    else snprintf(s->detail, sizeof(s->detail), "%s", text);
}
static bool same(const SCNetAddress *a, const SCNetAddress *b) {
    return a->index == b->index && !strcmp(a->name, b->name) && a->address == b->address && a->mask == b->mask;
}
static bool present(SCNetAddress *a, int n, const SCNetAddress *target) {
    for (int i = 0; i < n; i++) if (same(a + i, target)) return true;
    return false;
}
static bool private_ip(uint32_t address) {
    uint32_t n = ntohl(address);
    return (n >> 24) == 10 || (n >> 20) == 0xac1 || (n >> 16) == 0xc0a8;
}
bool sc_network_cleanup(SCNetState *s, const SCNetOps *ops) {
    s->ready = false;
    if (!s->owned) return true;
    SCNetAddress all[SC_NET_MAX];
    int n = ops->snapshot(ops->context, all, SC_NET_MAX);
    if (n < 0) { result(s, "cleanup_failed", "Cannot inspect owned address", -n); return false; }
    for (int i = 0; i < n; i++) if (all[i].index == s->alias.index && !strcmp(all[i].name, s->alias.name) &&
        all[i].address == s->alias.address && all[i].mask != s->alias.mask) {
        result(s, "cleanup_failed", "Owned alias was changed externally; refusing broad deletion", EBUSY); return false;
    }
    if (present(all, n, &s->alias)) {
        int error = ops->alias(ops->context, &s->alias, false);
        if (error) { result(s, "cleanup_failed", "Remove owned /32 alias", error); return false; }
        n = ops->snapshot(ops->context, all, SC_NET_MAX);
        if (n < 0 || present(all, n, &s->alias)) {
            result(s, "cleanup_failed", "Alias removal not confirmed", n < 0 ? -n : EBUSY); return false;
        }
    }
    s->owned = false;
    result(s, "stopped", "Owned alias removed; kernel removes its local route", 0);
    return true;
}
void sc_network_tick(SCNetState *s, const SCNetOps *ops) {
    SCNetAddress all[SC_NET_MAX];
    int n = ops->snapshot(ops->context, all, SC_NET_MAX);
    if (n < 0) { result(s, "inspect_failed", "Enumerate IPv4 interfaces", -n); return; }
    if (!strcmp(s->phase, "cleanup_failed")) {
        /* Do not install anything while rollback is unconfirmed. */
        sc_network_cleanup(s, ops); return;
    }
    if (s->failures >= 3) {
        if (s->owned && !sc_network_cleanup(s, ops)) return;
        result(s, "retry_required", "Three address/route failures; check log, then disable and re-enable probe", 0); return;
    }
    if (s->owned && (!present(all, n, &s->primary) || !present(all, n, &s->alias))) {
        if (present(all, n, &s->primary) && !present(all, n, &s->alias)) s->failures++;
        if (!sc_network_cleanup(s, ops)) return;
        n = ops->snapshot(ops->context, all, SC_NET_MAX);
        if (n < 0) { result(s, "inspect_failed", "Recheck hotspot", -n); return; }
    }
    SCNetAddress primary = {0};
    unsigned candidates = 0;
    uint32_t target; inet_pton(AF_INET, SC_COMPAT_IP, &target);
    for (int i = 0; i < n; i++) {
        if (strncmp(all[i].name, "bridge", 6) || !(all[i].flags & IFF_UP) ||
            !private_ip(all[i].address) || !all[i].mask || all[i].mask == UINT32_MAX) continue;
        uint32_t mask = ntohl(all[i].mask), inv = ~mask;
        if (inv & (inv + 1)) continue;
        primary = all[i]; candidates++;
    }
    if (candidates != 1) {
        if (s->owned && !sc_network_cleanup(s, ops)) return;
        memset(&s->primary, 0, sizeof(s->primary));
        result(s, candidates ? "ambiguous_hotspot" : "waiting_hotspot",
            candidates ? "Multiple bridge IPv4 networks; no changes made" : "Enable Personal Hotspot and connect a client", 0); return;
    }
    if (s->owned && !same(&s->primary, &primary)) {
        if (!sc_network_cleanup(s, ops)) return;
        n = ops->snapshot(ops->context, all, SC_NET_MAX);
        if (n < 0) { result(s, "inspect_failed", "Recheck hotspot after cleanup", -n); return; }
    }
    if (!s->owned) {
        s->primary = primary;
        for (int i = 0; i < n; i++) if (all[i].address == target) {
            result(s, "address_conflict", "Compatibility address already exists; not adopted or removed", 0); return;
        }
        s->alias = primary;
        s->alias.address = target; s->alias.mask = UINT32_MAX;
        int error = ops->alias(ops->context, &s->alias, true);
        if (error) { s->failures++; result(s, "add_failed", "SIOCAIFADDR /32 alias", error); return; }
        s->owned = true;
    }
    n = ops->snapshot(ops->context, all, SC_NET_MAX);
    SCNetRoute route = {0};
    int error = ops->route(ops->context, target, &route);
    bool verified = n >= 0 && present(all, n, &s->primary) && present(all, n, &s->alias) && !error && route.local;
    if (!verified) {
        s->failures++;
        if (!sc_network_cleanup(s, ops)) return;
        result(s, "verify_failed", "Alias/primary/local route check failed; rolled back", error); return;
    }
    result(s, "local_ready", "Local /32 alias and local host route verified; Tesla access not yet proven", 0);
}

static int snapshot(void *unused, SCNetAddress *out, int capacity) {
    (void)unused;
    struct ifaddrs *all = NULL;
    if (getifaddrs(&all)) return -errno;
    int n = 0;
    for (struct ifaddrs *a = all; a; a = a->ifa_next) {
        if (!a->ifa_addr || a->ifa_addr->sa_family != AF_INET) continue;
        if (n == capacity) { freeifaddrs(all); return -EOVERFLOW; }
        SCNetAddress *p = out + n++; memset(p, 0, sizeof(*p));
        snprintf(p->name, sizeof(p->name), "%s", a->ifa_name);
        p->address = ((struct sockaddr_in *)a->ifa_addr)->sin_addr.s_addr;
        if (a->ifa_netmask) p->mask = ((struct sockaddr_in *)a->ifa_netmask)->sin_addr.s_addr;
        p->index = if_nametoindex(a->ifa_name); p->flags = a->ifa_flags;
    }
    freeifaddrs(all); return n;
}
static void address(struct sockaddr *out, uint32_t ip) {
    struct sockaddr_in value = {0}; value.sin_len = sizeof(value); value.sin_family = AF_INET; value.sin_addr.s_addr = ip;
    memcpy(out, &value, sizeof(value));
}
static int alias(void *unused, const SCNetAddress *a, bool add) {
    (void)unused;
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return errno;
    int error;
    if (add) {
        struct ifaliasreq request = {0};
        snprintf(request.ifra_name, sizeof(request.ifra_name), "%s", a->name);
        address((struct sockaddr *)&request.ifra_addr, a->address);
        address((struct sockaddr *)&request.ifra_mask, a->mask);
        error = ioctl(fd, SIOCAIFADDR, &request) ? errno : 0;
    } else {
        struct ifreq request = {0};
        snprintf(request.ifr_name, sizeof(request.ifr_name), "%s", a->name);
        address(&request.ifr_addr, a->address);
        error = ioctl(fd, SIOCDIFADDR, &request) ? errno : 0;
    }
    close(fd); return error;
#else
    /* Desktop builds can inspect routes but must never mutate the Mac. */
    (void)a; (void)add; return ENOTSUP;
#endif
}
/* Stable Darwin PF_ROUTE v5 ABI. iPhoneOS SDK omits <net/route.h>.
 * Keep the layout checked against the macOS system header in tests. */
typedef struct {
    uint16_t length; uint8_t version, type; uint16_t index;
    int32_t flags, addresses, pid, sequence, error, use;
    uint32_t inits, metrics[14];
} SCRouteHeader;
_Static_assert(sizeof(SCRouteHeader) == 92, "Darwin route ABI");
int sc_network_route(uint32_t ip, SCNetRoute *out) {
    int fd = socket(PF_ROUTE, SOCK_RAW, AF_INET);
    if (fd < 0) return errno;
    struct { SCRouteHeader header; struct sockaddr_in dst; } message = {0};
    message.header = (SCRouteHeader){.length = sizeof(message), .version = 5, .type = 4,
        .addresses = 1, .pid = getpid(), .sequence = 1};
    address((struct sockaddr *)&message.dst, ip);
    int error = 0;
    if (write(fd, &message, sizeof(message)) != sizeof(message)) error = errno ?: EIO;
    if (!error) {
        error = ETIMEDOUT;
        for (int i = 0; i < 8; i++) {
            struct pollfd p = {fd, POLLIN, 0};
            if (poll(&p, 1, 100) <= 0) break;
            uint8_t bytes[2048]; ssize_t count = read(fd, bytes, sizeof(bytes));
            if (count < (ssize_t)sizeof(SCRouteHeader)) continue;
            SCRouteHeader header; memcpy(&header, bytes, sizeof(header));
            if (header.version != 5 || header.type != 4 || header.pid != getpid() || header.sequence != 1) continue;
            error = header.error;
            if (!error) { out->index = header.index; out->local = (header.flags & 0x200000) != 0; }
            break;
        }
    }
    close(fd); return error;
}
static int route(void *unused, uint32_t ip, SCNetRoute *out) { (void)unused; return sc_network_route(ip, out); }
SCNetOps sc_network_darwin_ops(void) { return (SCNetOps){NULL, snapshot, alias, route}; }

static volatile sig_atomic_t guardStopped;
static void guard_signal(int signal) { (void)signal; guardStopped = 1; }
int sc_network_guard(int channel, const SCNetOps *ops) {
    signal(SIGTERM, guard_signal); signal(SIGINT, guard_signal); signal(SIGPIPE, SIG_IGN);
    SCNetState state = {0};
    while (!guardStopped) {
        struct pollfd p = {channel, POLLIN, 0};
        int ready = poll(&p, 1, 1000);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) break;
        if (!ready) continue;
        char command;
        if (read(channel, &command, 1) != 1 || command != 'T') break;
        sc_network_tick(&state, ops);
        const char *bytes = (const char *)&state; size_t at = 0;
        while (at < sizeof(state)) {
            ssize_t n = write(channel, bytes + at, sizeof(state) - at);
            if (n <= 0) { guardStopped = 1; break; }
            at += (size_t)n;
        }
    }
    bool cleaned = false;
    for (int i = 0; i < 3 && !(cleaned = sc_network_cleanup(&state, ops)); i++) usleep(100000);
    fprintf(stderr, "[TESLA-NET] guard cleanup=%s phase=%s detail=%s\n", cleaned ? "ok" : "FAILED", state.phase, state.detail);
    close(channel); return cleaned ? 0 : 1;
}
