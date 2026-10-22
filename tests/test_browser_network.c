/* SPDX-License-Identifier: GPL-3.0-or-later
 * Production alias state machine + cleanup guard; all mutations are simulated.
 */
#include "../source/browser_network.h"
#include <arpa/inet.h>
#include <net/route.h>
#include <sys/socket.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    SCNetAddress all[8]; int count, adds, removes, addError, removeError, inspectError, routeError;
    bool local;
    double clock;
} Fixture;
static uint32_t ip(const char *text) { uint32_t value; assert(inet_pton(AF_INET, text, &value) == 1); return value; }
static SCNetAddress primary(unsigned index) {
    SCNetAddress a = {.address=ip("172.20.10.1"), .mask=ip("255.255.255.240"), .index=index, .flags=IFF_UP};
    snprintf(a.name, sizeof(a.name), "bridge100"); return a;
}
static Fixture fixture(void) { Fixture f = {.count=1, .local=true}; f.all[0]=primary(9); return f; }
static int snapshot(void *context, SCNetAddress *out, int capacity) {
    Fixture *f=context; if (f->inspectError) return -f->inspectError;
    assert(f->count+1 <= capacity); memcpy(out, f->all, f->count * sizeof(*out));
    SCNetAddress loopback={.address=ip("127.0.0.1"),.mask=ip("255.0.0.0"),.index=1,.flags=IFF_UP|IFF_LOOPBACK};
    snprintf(loopback.name,sizeof(loopback.name),"lo0"); out[f->count]=loopback;
    return f->count+1;
}
static int alias(void *context, const SCNetAddress *a, bool add) {
    Fixture *f=context;
    assert(a->address == ip(SC_COMPAT_IP) && a->mask == UINT32_MAX);
    assert(a->index == 1 && !strcmp(a->name,"lo0"));
    if (add) { f->adds++; if (f->addError) return f->addError; f->all[f->count++]=*a; }
    else {
        f->removes++; if (f->removeError) return f->removeError;
        int found=-1;
        for(int i=0;i<f->count;i++) if (!memcmp(a, f->all+i, sizeof(*a))) found=i;
        assert(found>=0); memmove(f->all+found, f->all+found+1, (--f->count-found)*sizeof(*a));
    }
    return 0;
}
static int route(void *context, uint32_t ip, SCNetRoute *r) { (void)ip; Fixture *f=context; *r=(SCNetRoute){9,f->local}; return f->routeError; }
static double fixture_now(void *context) { return ((Fixture *)context)->clock; }
static SCNetOps ops(Fixture *f) { return (SCNetOps){f,snapshot,alias,route,fixture_now}; }
static void tick(SCNetState *s, Fixture *f) { SCNetOps o=ops(f); sc_network_tick(s,&o); }
static void reset(SCNetState *s, Fixture *f) { memset(s,0,sizeof(*s)); *f=fixture(); }
static void request(int fd, SCNetState *s) {
    assert(write(fd,"T",1)==1); size_t at=0;
    while(at<sizeof(*s)) { ssize_t n=read(fd,(char*)s+at,sizeof(*s)-at); assert(n>0); at+=(size_t)n; }
}
static void wait_clean(Fixture *f) { for(int i=0;i<100 && f->count!=1;i++) usleep(20000); assert(f->count==1); }
int main(void) {
    assert(sizeof(struct rt_msghdr)==92);
    Fixture f=fixture(); SCNetState s={0}; SCNetAddress original=f.all[0];
    tick(&s,&f); assert(s.ready && s.owned && f.adds==1 && f.count==2);
    assert(!memcmp(&original,f.all,sizeof(original)));
    tick(&s,&f); assert(f.adds==1 && f.removes==0);
    SCNetOps o=ops(&f); assert(sc_network_cleanup(&s,&o)); assert(f.count==1 && !s.owned);
    // Missing/ambiguous hotspot: never guess an interface or change DHCP.
    reset(&s,&f); f.count=0; tick(&s,&f); assert(!strcmp(s.phase,"waiting_hotspot") && !f.adds);
    reset(&s,&f); f.all[1]=primary(10); f.count=2; tick(&s,&f); assert(!strcmp(s.phase,"ambiguous_hotspot") && !f.adds);
    reset(&s,&f); f.all[0].flags=0; tick(&s,&f); assert(!f.adds);
    // Pre-existing addresses are never adopted, modified or removed.
    reset(&s,&f); f.all[1]=primary(20); f.all[1].address=ip(SC_COMPAT_IP); f.count=2;
    tick(&s,&f); assert(!strcmp(s.phase,"address_conflict") && !f.adds && !f.removes);
    o=ops(&f); assert(sc_network_cleanup(&s,&o)); assert(f.count==2);
    reset(&s,&f); f.addError=EPERM; tick(&s,&f); assert(!s.owned && !s.ready && f.count==1);
    tick(&s,&f); assert(f.adds==1 && !strcmp(s.phase,"retry_wait"));
    f.clock=1; tick(&s,&f); assert(f.adds==2 && s.failures==2 && s.retryAt==3);
    f.clock=3; tick(&s,&f); assert(f.adds==3 && s.failures==3 && s.retryAt==7);
    f.addError=0; f.clock=7; tick(&s,&f); assert(s.ready && s.failures==0 && s.retryAt==0);
    // A later isolated failure starts at one again, not lifetime failure four.
    f.local=false; tick(&s,&f); assert(s.failures==1 && s.retryAt==8 && !s.owned);
    f.local=true; f.clock=8; tick(&s,&f); assert(s.ready && s.failures==0);
    // Persistent errors back off automatically, capped at 30 seconds.
    reset(&s,&f); f.addError=EPERM;
    for(int i=0;i<12;i++) { f.clock=s.retryAt; tick(&s,&f); assert(s.retryAt-f.clock<=30 && !s.owned); }
    f.addError=0; f.clock=s.retryAt; tick(&s,&f); assert(s.ready && s.failures==0);
    // Local host-route failure rolls back precisely the newly created /32.
    reset(&s,&f); f.local=false; tick(&s,&f); assert(!s.ready && f.adds==1 && f.removes==1 && f.count==1);
    reset(&s,&f); f.routeError=ETIMEDOUT; tick(&s,&f); assert(f.count==1 && !s.owned);
    // Hotspot bridge recreated; old identity is not reused blindly.
    reset(&s,&f); tick(&s,&f); f.all[0]=primary(11); tick(&s,&f);
    assert(s.ready && s.primary.index==11 && f.adds==2 && f.removes==1);
    // Hotspot removed: forget vanished interfaces without broad deletion.
    f.count=0; tick(&s,&f); assert(!s.owned && !s.ready && !strcmp(s.phase,"waiting_hotspot"));
    // Externally changed alias: stop and preserve it; do not claim rollback.
    reset(&s,&f); tick(&s,&f); f.all[1].mask=ip("255.255.255.0"); o=ops(&f);
    assert(!sc_network_cleanup(&s,&o)); assert(!strcmp(s.phase,"cleanup_failed") && !f.removes);
    tick(&s,&f); assert(f.adds==1 && !s.ready);
    reset(&s,&f); f.local=false; f.removeError=EPERM; tick(&s,&f);
    assert(!strcmp(s.phase,"cleanup_failed") && s.owned); tick(&s,&f); assert(f.adds==1);
    // Real guard EOF cleanup, including a controller killed with SIGKILL.
    Fixture *shared=mmap(NULL,sizeof(*shared),PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANON,-1,0); assert(shared!=MAP_FAILED);
    *shared=fixture(); int sockets[2]; assert(!socketpair(AF_UNIX,SOCK_STREAM,0,sockets));
    pid_t guard=fork(); assert(guard>=0);
    if(!guard) { close(sockets[0]); SCNetOps g=ops(shared); _exit(sc_network_guard(sockets[1],&g)); }
    close(sockets[1]); request(sockets[0],&s); assert(s.ready); close(sockets[0]); int status;
    assert(waitpid(guard,&status,0)==guard && WEXITSTATUS(status)==0); wait_clean(shared);
    *shared=fixture(); int ready[2]; assert(!pipe(ready));
    pid_t controller=fork(); assert(controller>=0);
    if(!controller) {
        close(ready[0]); assert(!socketpair(AF_UNIX,SOCK_STREAM,0,sockets)); guard=fork(); assert(guard>=0);
        if(!guard) { close(sockets[0]); close(ready[1]); SCNetOps g=ops(shared); _exit(sc_network_guard(sockets[1],&g)); }
        close(sockets[1]); request(sockets[0],&s); assert(s.ready); assert(write(ready[1],"R",1)==1); close(ready[1]);
        for(;;) pause();
    }
    close(ready[1]); char mark; assert(read(ready[0],&mark,1)==1); close(ready[0]);
    kill(controller,SIGKILL); waitpid(controller,&status,0); wait_clean(shared);
    munmap(shared,sizeof(*shared));
    puts("PASS: alias transaction, unchanged primary, no/ambiguous hotspot, conflict preservation, rollback, interface recreation, cleanup failure, guard EOF/SIGKILL cleanup (simulated mutations)");
    return 0;
}
