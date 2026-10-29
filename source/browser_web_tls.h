/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#import <Foundation/Foundation.h>
/* Returns a TLS identity chain only after hostname/time/system trust checks.
 * No key, P12 password or certificate is bundled with this application. */
NSArray *showcase_web_identity(NSDictionary *configuration, NSString *directory,
                             NSString *domain, NSString **message);
NSArray *showcase_web_identity_data(NSData *bytes, NSString *password, NSDictionary *configuration,
                                  NSString *domain, NSString **message);
@interface SCWebTLS : NSObject
@property (nonatomic, readonly) BOOL wantsWrite;
- (instancetype)initWithFD:(int)fd certificates:(NSArray *)certificates;
- (int)handshake; /* 1 ready, 0 would-block, -1 failed */
- (ssize_t)read:(void *)bytes length:(size_t)length;
- (ssize_t)write:(const void *)bytes length:(size_t)length;
- (BOOL)flush;
- (BOOL)buffered;
@end
