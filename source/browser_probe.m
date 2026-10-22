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
#include "browser_web_tls.h"

#define MAX_CONNECTIONS 12
#define RELAY_LIMIT (1024 * 1024)
static NSString *webDomain, *httpsMessage;
static bool httpsReady;
static uint16_t httpsPort = 443, backendPort = BROWSER_PORT;

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
@property (nonatomic, strong) NSMutableData *output;
@property (nonatomic, strong) NSMutableData *upload;
@property (nonatomic, strong) SCWebTLS *tls;
@property bool tlsReady, connecting, backendEnded;
@property int backend, mode; /* 0 header, 1 static response, 2 loopback relay */
@end
@implementation SCProbeClient
@end
static NSDictionary *report(SCNetState *s, bool port80, uint16_t port, uint64_t requests, uint64_t tls) {
    return @{@"version": @"Browser4", @"pid": @(getpid()), @"parentPid": @(getppid()),
        @"updated": @(NSDate.date.timeIntervalSince1970), @"localReady": @(s->ready),
        @"phase": [NSString stringWithUTF8String:s->phase], @"detail": [NSString stringWithUTF8String:s->detail],
        @"interface": [NSString stringWithUTF8String:s->primary.name], @"hotspotAddress": ip(s->primary.address),
        @"compatibilityAddress": @SC_COMPAT_IP, @"port80": @(port80), @"probePort": @(port),
        @"domain": webDomain ?: @"", @"httpsReady": @(httpsReady), @"httpsPort": @(httpsPort),
        @"httpsStatus": httpsMessage ?: @"", @"probeRequests": @(requests), @"tlsOnHTTP": @(tls)};
}
static void reply(SCProbeClient *c, int code, NSString *mime, NSData *body) {
    NSString *header = [NSString stringWithFormat:@"HTTP/1.1 %d %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'\r\n\r\n",
        code, code == 200 ? @"OK" : @"Rejected", mime, (unsigned long)body.length];
    NSMutableData *output = [[header dataUsingEncoding:NSUTF8StringEncoding] mutableCopy]; [output appendData:body]; c.output = output; c.sent = 0; c.mode = 1;
}
static bool authority(NSString *host, uint32_t local, uint16_t port) {
    NSString *address = ip(local);
    NSString *lower = host.lowercaseString;
    for (NSString *name in @[address, webDomain ?: @""]) {
        if (!name.length) continue;
        if ([lower isEqualToString:[NSString stringWithFormat:@"%@:%u", name, port]] ||
            ((port == 80 || port == 443) && [lower isEqualToString:name])) return true;
    }
    return false;
}
static bool origin_valid(NSString *origin, NSString *host, SCProbeClient *c) {
    if (!origin) return true;
    NSURLComponents *u = [NSURLComponents componentsWithString:origin];
    NSString *scheme = c.tls ? @"https" : @"http";
    if (![u.scheme isEqual:scheme] || u.user || u.password || u.query || u.fragment || u.path.length) return false;
    NSInteger port = u.port ? u.port.integerValue : c.tls ? 443 : 80;
    NSString *expected = [[host componentsSeparatedByString:@":"] firstObject];
    return port == c.port && [u.host.lowercaseString isEqual:expected.lowercaseString];
}
static size_t pending(SCProbeClient *c) { return c.output.length - c.sent; }
static void append_down(SCProbeClient *c, const void *bytes, size_t count) {
    if (!c.output) c.output = [NSMutableData data];
    if (c.sent) { [c.output replaceBytesInRange:NSMakeRange(0,c.sent) withBytes:NULL length:0]; c.sent = 0; }
    [c.output appendBytes:bytes length:count];
}
static bool start_relay(SCProbeClient *c, NSString *path, NSDictionary *headers) {
    bool websocket = [path isEqual:@"/media"] || [path isEqual:@"/control"];
    NSString *host = [NSString stringWithFormat:@"127.0.0.1:%u", backendPort];
    NSMutableString *request = [NSMutableString stringWithFormat:@"GET %@ HTTP/1.1\r\nHost: %@\r\nConnection: %@\r\n", path, host, websocket ? @"Upgrade" : @"close"];
    if (websocket) {
        [request appendFormat:@"Upgrade: websocket\r\nOrigin: http://%@\r\n",host];
        for (NSString *key in @[@"sec-websocket-version",@"sec-websocket-key",@"sec-websocket-protocol"])
            if (headers[key]) [request appendFormat:@"%@: %@\r\n",key,headers[key]];
    } else if (headers[@"x-showcase-token"]) [request appendFormat:@"X-Showcase-Token: %@\r\n",headers[@"x-showcase-token"]];
    [request appendString:@"\r\n"];
    int fd = socket(AF_INET,SOCK_STREAM,0); if (fd < 0) return false;
    fcntl(fd,F_SETFL,O_NONBLOCK); int yes=1;
    setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes)); setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof(yes));
    struct sockaddr_in dst={0}; dst.sin_len=sizeof(dst); dst.sin_family=AF_INET; dst.sin_port=htons(backendPort); inet_pton(AF_INET,"127.0.0.1",&dst.sin_addr);
    int result=connect(fd,(struct sockaddr*)&dst,sizeof(dst));
    if (result && errno!=EINPROGRESS) { close(fd); return false; }
    c.backend=fd; c.connecting=result!=0; c.mode=2;
    c.upload=[[request dataUsingEncoding:NSUTF8StringEncoding] mutableCopy]; c.input=nil; return true;
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
    setvbuf(stdout,NULL,_IOLBF,0); setvbuf(stderr,NULL,_IOLBF,0);
    pid_t parent=0; uint16_t port=BROWSER_PROBE_PORT, httpPort=80;
    NSString *statePath=BROWSER_PROBE_STATE;
    for (int i=1;i<argc;i++) {
        if (!strcmp(argv[i],"--parent") && i+1<argc) parent=(pid_t)atoi(argv[++i]);
#ifdef SC_PROBE_TEST
        else if (!strcmp(argv[i],"--test-state") && i+1<argc) statePath=[NSString stringWithUTF8String:argv[++i]];
        else if (!strcmp(argv[i],"--test-port") && i+1<argc) port=(uint16_t)atoi(argv[++i]);
        else if (!strcmp(argv[i],"--test-http-port") && i+1<argc) httpPort=(uint16_t)atoi(argv[++i]);
        else if (!strcmp(argv[i],"--test-https-port") && i+1<argc) httpsPort=(uint16_t)atoi(argv[++i]);
#endif
        else { fprintf(stderr,"Unknown argument\n"); return 2; }
    }
    if (parent<=1 || getppid()!=parent) { fprintf(stderr,"Parent process mismatch\n"); return 2; }
#ifndef SC_PROBE_TEST
    if (geteuid()!=0 || !TARGET_OS_IPHONE || TARGET_OS_SIMULATOR) { fprintf(stderr,"Requires jailbroken iOS root helper\n"); return 3; }
    setuid(0); setgid(0);
#endif
    NSString *directory=statePath.stringByDeletingLastPathComponent;
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    NSString *lockPath=[statePath stringByAppendingString:@".lock"];
    int lock=open(lockPath.fileSystemRepresentation,O_RDWR|O_CREAT|O_NOFOLLOW,0600);
    if (lock<0 || flock(lock,LOCK_EX|LOCK_NB)) { fprintf(stderr,"Network entry already running or lock unavailable\n"); if(lock>=0) close(lock); return 4; }
    signal(SIGPIPE,SIG_IGN); signal(SIGTERM,stop_signal); signal(SIGINT,stop_signal);
    int ports[3]={listener(port),-1,-1};
    if (ports[0]<0) { fprintf(stderr,"Fallback port %u unavailable: %s\n",port,strerror(errno)); close(lock); return 5; }
#ifdef SC_PROBE_TEST
    if (httpPort!=80) ports[1]=listener(httpPort);
#else
    ports[1]=listener(httpPort);
#endif
    if (ports[1]<0) fprintf(stderr,"[TESLA-NET] standard HTTP port unavailable; fallback=%u\n",port);
    int channel[2]; if(socketpair(AF_UNIX,SOCK_STREAM,0,channel)) return 6;
    pid_t guard=fork(); if(guard<0) return 7;
    if (!guard) {
        close(channel[0]); for(int i=0;i<3;i++) if(ports[i]>=0) close(ports[i]);
        SCNetOps ops=sc_network_darwin_ops(); int rc=sc_network_guard(channel[1],&ops); close(lock); _exit(rc);
    }
    close(channel[1]);
    NSData *configData=[NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"browser-web.json"]];
    id decoded=configData.length<=8192 && configData ? [NSJSONSerialization JSONObjectWithData:configData options:0 error:NULL] : nil;
    NSDictionary *configuration=[decoded isKindOfClass:NSDictionary.class] ? decoded : @{};
    webDomain=showcase_web_domain_valid(configuration[@"domain"]) ? configuration[@"domain"] : BROWSER_WEB_DOMAIN;
#ifdef SC_PROBE_TEST
    if ([configuration[@"testBackendPort"] isKindOfClass:NSNumber.class]) backendPort=[configuration[@"testBackendPort"] unsignedShortValue];
#endif
    NSString *tlsStatus = nil;
    NSArray *certificates=showcase_web_identity(configuration,directory,webDomain,&tlsStatus);
    httpsMessage=tlsStatus;
    if(certificates) {
        ports[2]=listener(httpsPort); httpsReady=ports[2]>=0;
        if(!httpsReady) httpsMessage=@"证书有效，但 HTTPS 端口被占用，未启用 HTTPS";
    }
    fprintf(stderr,"[TESLA-NET] Browser4 domain=%s HTTP=%s HTTPS=%s\n",webDomain.UTF8String,ports[1]>=0 ? "standard+fallback" : "fallback",httpsReady ? "ready" : "not configured");
    SCNetState state={0}; bool port80=ports[1]>=0;
    NSMutableArray<SCProbeClient*> *clients=[NSMutableArray array];
    uint64_t requests=0,tls=0; double nextTick=0;
    while(!stopped && getppid()==parent) { @autoreleasepool {
        if(now()>=nextTick) {
            char previous[sizeof(state.detail)]; snprintf(previous,sizeof(previous),"%s",state.detail);
            if(!tick(channel[0],&state)) { fprintf(stderr,"[TESLA-NET] guard channel failed\n"); break; }
            if(strcmp(previous,state.detail)) fprintf(stderr,"[TESLA-NET] phase=%s interface=%s detail=%s\n",state.phase,state.primary.name,state.detail);
            NSData *json=[NSJSONSerialization dataWithJSONObject:report(&state,port80,port,requests,tls) options:NSJSONWritingPrettyPrinted error:NULL];
            [json writeToFile:statePath options:NSDataWritingAtomic error:NULL]; chmod(statePath.fileSystemRepresentation,0644); nextTick=now()+1;
        }
        NSArray<SCProbeClient*> *snapshot=[clients copy]; struct pollfd fds[3+2*MAX_CONNECTIONS];
        for(int i=0;i<3;i++) fds[i]=(struct pollfd){ports[i],POLLIN,0};
        for(NSUInteger i=0;i<snapshot.count;i++) {
            SCProbeClient *c=snapshot[i]; short interest=0;
            if(!c.tlsReady) interest=POLLIN | (c.tls.wantsWrite ? POLLOUT : 0);
            else {
                if(c.mode==0 || (c.mode==2 && c.upload.length<RELAY_LIMIT)) interest|=POLLIN;
                if(pending(c) || c.tls.wantsWrite) interest|=POLLOUT;
            }
            fds[3+i*2]=(struct pollfd){c.fd,interest,0};
            short upstream=0;
            if(c.connecting || c.upload.length) upstream|=POLLOUT;
            if(!c.backendEnded && pending(c)<RELAY_LIMIT) upstream|=POLLIN;
            fds[4+i*2]=(struct pollfd){c.backend,upstream,0};
        }
        if(poll(fds,(nfds_t)snapshot.count*2+3,30)<0 && errno!=EINTR) break;
        for(int i=0;i<3;i++) if(fds[i].revents&POLLIN) {
            struct sockaddr_in peer={0},local={0}; socklen_t length=sizeof(peer);
            int fd=accept(ports[i],(struct sockaddr*)&peer,&length); if(fd<0) continue;
            if(clients.count>=MAX_CONNECTIONS || !allowed(peer.sin_addr.s_addr,&state)) { close(fd); continue; }
            length=sizeof(local); if(getsockname(fd,(struct sockaddr*)&local,&length)) { close(fd); continue; }
            fcntl(fd,F_SETFL,O_NONBLOCK); int yes=1;
            setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes)); setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof(yes));
            SCProbeClient *c=[SCProbeClient new]; c.fd=fd; c.backend=-1; c.port=ntohs(local.sin_port);
            c.local=local.sin_addr.s_addr; c.peer=peer.sin_addr.s_addr; c.started=now(); c.input=[NSMutableData data];
            if(i==2) { c.tls=[[SCWebTLS alloc] initWithFD:fd certificates:certificates]; if(!c.tls) { close(fd); continue; } }
            c.tlsReady=c.tls==nil; [clients addObject:c];
        }
        for(NSUInteger i=0;i<snapshot.count;i++) {
            SCProbeClient *c=snapshot[i]; short events=fds[3+i*2].revents,up=fds[4+i*2].revents;
            bool remove=now()-c.started>(c.mode==2 ? 25 : 6) || (events&(POLLHUP|POLLERR|POLLNVAL));
            if(!remove && !c.tlsReady) {
                int result=[c.tls handshake]; if(result<0) remove=true; else if(result>0) { c.tlsReady=true; c.started=now(); }
            }
            if(!remove && c.tlsReady && c.tls.wantsWrite && (events&POLLOUT) && ![c.tls flush]) remove=true;
            if(!remove && c.tlsReady && ((events&POLLIN) || c.tls.buffered) && c.mode!=1) {
                uint8_t bytes[65536]; size_t space=c.mode==2 ? RELAY_LIMIT-c.upload.length : sizeof(bytes);
                ssize_t n=space ? (c.tls ? [c.tls read:bytes length:MIN(sizeof(bytes),space)] : recv(c.fd,bytes,MIN(sizeof(bytes),space),0)) : -1;
                if(!space) errno=EAGAIN;
                if(n==0 || (n<0 && errno!=EAGAIN && errno!=EINTR)) remove=true;
                if(n>0) {
                    c.started=now();
                    if(c.mode==2) [c.upload appendBytes:bytes length:(NSUInteger)n];
                    else [c.input appendBytes:bytes length:(NSUInteger)n];
                }
                if(c.mode==0 && !c.tls && c.input.length && ((const uint8_t*)c.input.bytes)[0]==0x16) {
                    tls++; fprintf(stderr,"[TESLA-NET] TLS arrived on HTTP port %u\n",c.port); remove=true;
                }
                NSData *end=[@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding];
                NSRange boundary=c.mode==0 ? [c.input rangeOfData:end options:0 range:NSMakeRange(0,c.input.length)] : NSMakeRange(NSNotFound,0);
                if(!remove && boundary.location!=NSNotFound) {
                    NSString *text=[[NSString alloc] initWithData:[c.input subdataWithRange:NSMakeRange(0,boundary.location)] encoding:NSUTF8StringEncoding];
                    NSArray *lines=[text componentsSeparatedByString:@"\r\n"],*request=[lines.firstObject componentsSeparatedByString:@" "];
                    NSMutableDictionary *headers=[NSMutableDictionary dictionary];
                    bool valid=request.count==3 && [request[0] isEqual:@"GET"] && [request[2] isEqual:@"HTTP/1.1"];
                    for(NSUInteger k=1;k<lines.count;k++) {
                        NSRange colon=[lines[k] rangeOfString:@":"]; if(colon.location==NSNotFound) { valid=false; continue; }
                        NSString *key=[[lines[k] substringToIndex:colon.location] lowercaseString];
                        NSString *value=[[lines[k] substringFromIndex:colon.location+1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
                        if(headers[key] || [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location!=NSNotFound) valid=false;
                        headers[key]=value;
                    }
                    valid=valid && c.input.length<=8192 && authority(headers[@"host"],c.local,c.port);
                    NSString *path=request.count>1 ? request[1] : @"";
                    if(!valid) reply(c,400,@"text/plain",[@"Invalid local HTTP request" dataUsingEncoding:NSUTF8StringEncoding]);
                    else if(!origin_valid(headers[@"origin"],headers[@"host"],c)) reply(c,403,@"text/plain",[@"Same origin required" dataUsingEncoding:NSUTF8StringEncoding]);
                    else if([path isEqual:@"/"] || [path isEqual:@"/player.js"] || [path isEqual:@"/probe"] || [path isEqual:@"/probe.js"]) {
                        bool script=[path hasSuffix:@".js"];
                        const char *asset=[path isEqual:@"/"] ? browser_index_html : [path isEqual:@"/player.js"] ? browser_player_js : [path isEqual:@"/probe.js"] ? browser_probe_js : browser_probe_html;
                        if(!script) { requests++; fprintf(stderr,"[TESLA-NET] HTTP page received port=%u TLS=%d\n",c.port,c.tls!=nil); }
                        reply(c,200,script ? @"application/javascript" : @"text/html; charset=utf-8",[NSData dataWithBytes:asset length:strlen(asset)]);
                    } else if([path isEqual:@"/probe.json"]) {
                        requests++; NSMutableDictionary *data=[report(&state,port80,port,requests,tls) mutableCopy];
                        SCNetRoute route={0}; int error=sc_network_route(c.peer,&route); char name[IFNAMSIZ]="";
                        if(!error) if_indextoname(route.index,name);
                        data[@"returnInterface"]=[NSString stringWithUTF8String:name]; data[@"returnViaHotspot"]=@(!error && state.primary.index && route.index==state.primary.index);
                        reply(c,200,@"application/json",[NSJSONSerialization dataWithJSONObject:data options:0 error:NULL]);
                    } else if([path isEqual:@"/status"] || [path isEqual:@"/media"] || [path isEqual:@"/control"]) {
                        bool ws=![path isEqual:@"/status"];
                        if(ws && (!headers[@"origin"] || ![[headers[@"upgrade"] lowercaseString] isEqual:@"websocket"]))
                            reply(c,403,@"text/plain",[@"Same-origin WebSocket required" dataUsingEncoding:NSUTF8StringEncoding]);
                        else if(!start_relay(c,path,headers)) reply(c,503,@"text/plain",[@"Start a browser-enabled CarPlay session in Showcase" dataUsingEncoding:NSUTF8StringEncoding]);
                    } else reply(c,404,@"text/plain",[@"Not found" dataUsingEncoding:NSUTF8StringEncoding]);
                }
                if(c.mode==0 && c.input.length>8192) remove=true;
            }
            if(!remove && c.mode==2) {
                if(c.connecting && (up&(POLLOUT|POLLERR|POLLHUP))) {
                    int error=0; socklen_t length=sizeof(error);
                    if(getsockopt(c.backend,SOL_SOCKET,SO_ERROR,&error,&length) || error) {
                        close(c.backend); c.backend=-1; c.upload=nil; c.connecting=false;
                        reply(c,503,@"text/plain",[@"Start a browser-enabled CarPlay session in Showcase" dataUsingEncoding:NSUTF8StringEncoding]);
                    } else c.connecting=false;
                }
                if(c.mode==2 && !c.connecting) {
                    if(up&POLLOUT && c.upload.length) {
                        ssize_t n=send(c.backend,c.upload.bytes,MIN(c.upload.length,65536),0);
                        if(n>0) { [c.upload replaceBytesInRange:NSMakeRange(0,(NSUInteger)n) withBytes:NULL length:0]; c.started=now(); }
                        else if(n==0 || (errno!=EINTR && errno!=EAGAIN)) remove=true;
                    }
                    if(!remove && (up&(POLLIN|POLLHUP)) && !c.backendEnded && pending(c)<RELAY_LIMIT) {
                        uint8_t bytes[65536]; ssize_t n=recv(c.backend,bytes,MIN(sizeof(bytes),RELAY_LIMIT-pending(c)),0);
                        if(n>0) { append_down(c,bytes,(size_t)n); c.started=now(); }
                        else if(n==0) { c.backendEnded=true; close(c.backend); c.backend=-1; }
                        else if(errno!=EINTR && errno!=EAGAIN) remove=true;
                    }
                    if(up&(POLLERR|POLLNVAL)) remove=true;
                }
            }
            if(!remove && c.tlsReady && (events&POLLOUT) && pending(c)) {
                const uint8_t *bytes=c.output.bytes;
                ssize_t n=c.tls ? [c.tls write:bytes+c.sent length:MIN(pending(c),65536)] : send(c.fd,bytes+c.sent,MIN(pending(c),65536),0);
                if(n>0) { c.sent+=(size_t)n; c.started=now(); }
                else if(n==0 || (errno!=EINTR && errno!=EAGAIN)) remove=true;
            }
            if(c.tlsReady && !pending(c) && !c.tls.wantsWrite && (c.mode==1 || c.backendEnded)) remove=true;
            if(remove) { close(c.fd); if(c.backend>=0) close(c.backend); [clients removeObject:c]; }
        }
    } }
    for(SCProbeClient *c in clients) { close(c.fd); if(c.backend>=0) close(c.backend); }
    for(int i=0;i<3;i++) if(ports[i]>=0) close(ports[i]);
    close(channel[0]); int status=-1; while(waitpid(guard,&status,0)<0 && errno==EINTR) {}
    state.ready=false; httpsReady=false; snprintf(state.phase,sizeof(state.phase),"%s",WIFEXITED(status) && WEXITSTATUS(status)==0 ? "stopped" : "cleanup_failed");
    snprintf(state.detail,sizeof(state.detail),"%s","Web entry stopped; inspect network-probe.log if cleanup failed");
    NSData *json=[NSJSONSerialization dataWithJSONObject:report(&state,false,port,requests,tls) options:0 error:NULL];
    [json writeToFile:statePath options:NSDataWritingAtomic error:NULL]; close(lock);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
} }
