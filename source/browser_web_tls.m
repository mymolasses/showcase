/* SPDX-License-Identifier: GPL-3.0-or-later */
#import "browser_web_tls.h"
#import <Security/Security.h>
#import <Security/SecureTransport.h>
#include <TargetConditionals.h>
#include <sys/socket.h>
#include <errno.h>
#include <stdio.h>

NSArray *showcase_web_identity(NSDictionary *configuration, NSString *directory, NSString *domain, NSString **message) {
    NSString *managedFailure=nil;
    NSData *managed=[NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"browser-managed-identity.json"]];
    if(managed.length && managed.length<=400000) {
        id value=[NSJSONSerialization JSONObjectWithData:managed options:0 error:NULL];
        if([value isKindOfClass:NSDictionary.class] && [value[@"domain"] isEqual:domain]) {
            NSData *bytes=[value[@"pkcs12Base64"] isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:value[@"pkcs12Base64"] options:0] : nil;
            NSArray *identity=showcase_web_identity_data(bytes,value[@"identityPassword"],configuration,domain,&managedFailure);
            if(identity)return identity;
        }
    }
    NSString *password = configuration[@"identityPassword"];
    NSData *bytes = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"browser-server.p12"]];
    NSArray *identity=showcase_web_identity_data(bytes,password,configuration,domain,message);
    if(!identity&&managedFailure)*message=managedFailure;
    return identity;
}
NSArray *showcase_web_identity_data(NSData *bytes, NSString *password, NSDictionary *configuration, NSString *domain, NSString **message) {
    if (![password isKindOfClass:NSString.class]) { *message = @"等待自动接入激活，HTTPS 尚未就绪"; return nil; }
    if (!bytes || bytes.length > 256 * 1024) { *message = @"证书文件不存在或超过 256 KB，HTTPS 未启用"; return nil; }
    NSMutableDictionary *options = [@{(__bridge id)kSecImportExportPassphrase: password} mutableCopy];
#if TARGET_OS_OSX
    /* Never import test identities into the user's keychain. */
    if (@available(macOS 15.0, *)) options[(__bridge id)kSecImportToMemoryOnly] = @YES;
    else { *message = @"Desktop TLS tests require macOS 15+"; return nil; }
#endif
    CFArrayRef imported = NULL;
    OSStatus status = SecPKCS12Import((__bridge CFDataRef)bytes, (__bridge CFDictionaryRef)options, &imported);
    NSArray *items = CFBridgingRelease(imported);
    if (status || !items.count) { *message = @"证书导入失败，请检查 P12 文件与密码，HTTPS 未启用"; return nil; }
    NSDictionary *item = items.firstObject;
    id identity = item[(__bridge id)kSecImportItemIdentity];
    NSArray *chain = item[(__bridge id)kSecImportItemCertChain];
    if (!identity || !chain.count) { *message = @"证书缺少身份或完整证书链，HTTPS 未启用"; return nil; }
    SecPolicyRef policy = SecPolicyCreateSSL(true, (__bridge CFStringRef)domain);
    SecTrustRef trust = NULL;
    status = SecTrustCreateWithCertificates((__bridge CFArrayRef)chain, policy, &trust); CFRelease(policy);
    if (status || !trust) { *message = @"无法验证证书，HTTPS 未启用"; return nil; }
    SecTrustSetNetworkFetchAllowed(trust, false);
#ifdef SC_PROBE_TEST
    NSString *anchorPath = configuration[@"testAnchor"];
    if ([anchorPath isKindOfClass:NSString.class]) {
        NSData *anchorData = [NSData dataWithContentsOfFile:anchorPath];
        SecCertificateRef anchor = anchorData ? SecCertificateCreateWithData(NULL, (__bridge CFDataRef)anchorData) : NULL;
        if (anchor) { SecTrustSetAnchorCertificates(trust, (__bridge CFArrayRef)@[(__bridge id)anchor]); CFRelease(anchor); }
    }
#endif
    bool valid = SecTrustEvaluateWithError(trust, NULL); CFRelease(trust);
    if (!valid) { *message = @"证书未通过域名、有效期或系统信任检查，HTTPS 未启用"; return nil; }
    NSMutableArray *certificates = [NSMutableArray arrayWithObject:identity];
    for (NSUInteger i = 1; i < chain.count; i++) [certificates addObject:chain[i]];
    *message = @"证书通过本机域名与信任检查；车机仍需实际验证";
    return certificates;
}

typedef struct { int fd; bool blocked; } SCWebIO;
static OSStatus read_io(SSLConnectionRef connection, void *data, size_t *length) {
    SCWebIO *io = (SCWebIO *)connection; size_t wanted = *length;
    ssize_t n = recv(io->fd, data, wanted, 0); *length = n > 0 ? (size_t)n : 0;
    if (n > 0) return (size_t)n == wanted ? noErr : errSSLWouldBlock;
    if (!n) return errSSLClosedGraceful;
    return errno == EAGAIN || errno == EINTR ? errSSLWouldBlock : errSSLClosedAbort;
}
static OSStatus write_io(SSLConnectionRef connection, const void *data, size_t *length) {
    SCWebIO *io = (SCWebIO *)connection; size_t wanted = *length;
    ssize_t n = send(io->fd, data, wanted, 0); *length = n > 0 ? (size_t)n : 0;
    io->blocked = n < 0 || (size_t)n < wanted;
    if (n >= 0) return (size_t)n == wanted ? noErr : errSSLWouldBlock;
    return errno == EAGAIN || errno == EINTR ? errSSLWouldBlock : errSSLClosedAbort;
}
@implementation SCWebTLS {
    SSLContextRef _context;
    SCWebIO _io;
}
- (instancetype)initWithFD:(int)fd certificates:(NSArray *)certificates {
    if (!(self = [super init])) return nil;
    _io.fd = fd; _context = SSLCreateContext(NULL, kSSLServerSide, kSSLStreamType);
    if (!_context || SSLSetProtocolVersionMin(_context, kTLSProtocol12) || SSLSetProtocolVersionMax(_context, kTLSProtocol12) ||
        SSLSetIOFuncs(_context, read_io, write_io) || SSLSetConnection(_context, &_io) ||
        SSLSetCertificate(_context, (__bridge CFArrayRef)certificates)) return nil;
    return self;
}
- (void)dealloc { if (_context) CFRelease(_context); }
- (BOOL)wantsWrite { return _io.blocked; }
- (int)handshake {
    OSStatus s = SSLHandshake(_context);
    if (s && s != errSSLWouldBlock) fprintf(stderr,"[WEB-TLS] handshake failed status=%d\n",(int)s);
    return !s ? 1 : s == errSSLWouldBlock ? 0 : -1;
}
- (ssize_t)read:(void *)bytes length:(size_t)length {
    size_t done = 0; OSStatus s = SSLRead(_context, bytes, length, &done);
    if (done) return (ssize_t)done;
    if (s == errSSLClosedGraceful) return 0;
    errno = s == errSSLWouldBlock || !s ? EAGAIN : EIO; return -1;
}
- (ssize_t)write:(const void *)bytes length:(size_t)length {
    size_t done = 0; OSStatus s = SSLWrite(_context, bytes, length, &done);
    if (done) return (ssize_t)done;
    errno = s == errSSLWouldBlock || !s ? EAGAIN : EIO; return -1;
}
- (BOOL)flush { size_t done = 0; OSStatus s = SSLWrite(_context, NULL, 0, &done); return !s || s == errSSLWouldBlock; }
- (BOOL)buffered { size_t count = 0; return !SSLGetBufferedReadSize(_context, &count) && count; }
@end
