"""Run the production IPC accept loop against real sockets during a display restart."""
from pathlib import Path
import subprocess
import tempfile
import sys

if sys.platform != 'darwin':
    print('SKIP: production IPC restart test requires macOS Foundation')
    raise SystemExit(0)
root=Path(__file__).resolve().parents[1]
source=(root/'source/Showcase.m').read_text()
start=source.index('- (void)ipcAcceptLoop:')
method=source[start:source.index('static bool read_exact(',start)]
harness=r'''
#import <Foundation/Foundation.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <assert.h>
#include "display_geometry.h"
#define BROWSER_OUTPUT_KEY @"restart-test-browser-output"
#define MSG_PHONE_DISPLAY 12
enum {StateIdle,StateStopping,StateActive};
static volatile int g_touch_fd=-1;
static volatile uint32_t g_touch_epoch=0;
static void ip_log(const char *format,...) {(void)format;}
static void send_app_visibility(int visible) {(void)visible;}
static void send_ipc_payload(int type,const void *p,int length) {(void)type;(void)p;(void)length;}
static SCDisplaySize phone_display_size(void) {return (SCDisplaySize){1920,900};}
@interface TestApp : NSObject
@property int listenFd,clientFd,state,stopCount,endCount;
@property uint64_t ipcGeneration;
@property BOOL restartAfterStop;
@property(nonatomic,strong) dispatch_semaphore_t readEnded,releaseReader;
- (void)ipcAcceptLoop:(int)fd generation:(uint64_t)generation;
- (void)ipcHandleConnection:(int)fd;
- (void)endAWDLSuppression;
- (void)stopFlow;
@end
@implementation TestApp
- (void)ipcHandleConnection:(int)fd {
    char byte; while(read(fd,&byte,1)>0) {}
    if(self.readEnded) dispatch_semaphore_signal(self.readEnded);
    if(self.releaseReader) dispatch_semaphore_wait(self.releaseReader,DISPATCH_TIME_FOREVER);
}
- (void)endAWDLSuppression {self.endCount++;}
- (void)stopFlow {self.stopCount++;self.state=StateIdle;}
''' + method + r'''
@end
static int listener(uint16_t *port) {
    int fd=socket(AF_INET,SOCK_STREAM,0);assert(fd>=0);
    struct sockaddr_in addr={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    assert(bind(fd,(void*)&addr,sizeof(addr))==0);assert(listen(fd,2)==0);
    socklen_t size=sizeof(addr);assert(getsockname(fd,(void*)&addr,&size)==0);*port=ntohs(addr.sin_port);return fd;
}
static int client(uint16_t port) {
    int fd=socket(AF_INET,SOCK_STREAM,0);assert(fd>=0);
    struct sockaddr_in addr={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK),.sin_port=htons(port)};
    assert(connect(fd,(void*)&addr,sizeof(addr))==0);return fd;
}
int main(void) { @autoreleasepool {
    TestApp *app=[TestApp new];app.clientFd=-1;app.state=StateActive;app.ipcGeneration=1;
    app.readEnded=dispatch_semaphore_create(0);app.releaseReader=dispatch_semaphore_create(0);
    uint16_t port;int old=listener(&port);app.listenFd=old;
    dispatch_semaphore_t ended=dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(0,0),^{[app ipcAcceptLoop:old generation:1];dispatch_semaphore_signal(ended);});
    int sender=client(port);for(int i=0;i<200 && app.clientFd<0;i++)usleep(10000);assert(app.clientFd>=0);
    app.ipcGeneration=2;shutdown(app.clientFd,SHUT_RDWR);
    assert(dispatch_semaphore_wait(app.readEnded,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0);
    int replacement=socket(AF_INET,SOCK_STREAM,0);assert(replacement>=0);
    app.clientFd=replacement;g_touch_fd=replacement;
    dispatch_semaphore_signal(app.releaseReader);
    assert(dispatch_semaphore_wait(ended,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.05]];
    assert(app.stopCount==0 && app.endCount==0 && app.clientFd==replacement && g_touch_fd==replacement);
    assert(fcntl(replacement,F_GETFD)>=0);close(replacement);close(sender);close(old);
    app.readEnded=nil;app.releaseReader=nil;app.clientFd=-1;
    int fresh=listener(&port);app.listenFd=fresh;
    dispatch_async(dispatch_get_global_queue(0,0),^{[app ipcAcceptLoop:fresh generation:2];dispatch_semaphore_signal(ended);});
    sender=client(port);for(int i=0;i<200 && app.clientFd<0;i++)usleep(10000);assert(app.clientFd>=0);close(sender);
    assert(dispatch_semaphore_wait(ended,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.05]];
    assert(app.stopCount==1 && app.endCount==1 && app.restartAfterStop && g_touch_fd==-1);
    close(fresh);puts("PASS: production IPC stale reader preserves new session/fd; genuine disconnect still restarts");
} }
'''
with tempfile.TemporaryDirectory() as directory:
    path=Path(directory);(path/'restart.m').write_text(harness)
    subprocess.run(['clang','-fobjc-arc','-framework','Foundation','-I',str(root/'source'),str(path/'restart.m'),'-o',str(path/'restart')],check=True)
    subprocess.run([str(path/'restart')],check=True,timeout=10)
