/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <net/if.h>

#define SC_COMPAT_IP "99.99.99.99"
#define SC_NET_MAX 64

typedef struct {
    char name[IFNAMSIZ];
    uint32_t address, mask; /* network byte order */
    unsigned index, flags;
} SCNetAddress;
typedef struct {
    unsigned index;
    bool local;
} SCNetRoute;
typedef struct {
    void *context;
    int (*snapshot)(void *, SCNetAddress *, int); /* count or negative errno */
    int (*alias)(void *, const SCNetAddress *, bool add); /* errno, 0 on success */
    int (*route)(void *, uint32_t, SCNetRoute *);
} SCNetOps;
typedef struct {
    bool owned, ready;
    unsigned failures;
    SCNetAddress primary;
    SCNetAddress alias;
    char phase[32], detail[224];
} SCNetState;

void sc_network_tick(SCNetState *, const SCNetOps *);
bool sc_network_cleanup(SCNetState *, const SCNetOps *);
SCNetOps sc_network_darwin_ops(void);
int sc_network_route(uint32_t address, SCNetRoute *);
/* One byte 'T' requests a tick + raw SCNetState reply. EOF/'Q'/SIGTERM
 * removes only the alias this guard created. No shell or packet filter. */
int sc_network_guard(int channel, const SCNetOps *);
