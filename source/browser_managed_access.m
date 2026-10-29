/* SPDX-License-Identifier: GPL-3.0-or-later.
 * Native certificate control plane. No DNS API credentials and no CA bypass.
 */
#import "browser_managed_access.h"
#import "browser_settings.h"
#import "browser_web_tls.h"
#import <Security/Security.h>
#include <sys/stat.h>
#include <dispatch/dispatch.h>
#include <TargetConditionals.h>

static NSString *managedStatus=@"自动热点接入：尚未激活";
static BOOL busy;
static NSTimeInterval nextCheck;
static NSString *privatePath(NSString *path) {
#ifdef SC_MANAGED_TEST
    NSString *directory=NSProcessInfo.processInfo.environment[@"SC_MANAGED_TEST_DIRECTORY"];
    if(directory.length)return [directory stringByAppendingPathComponent:path.lastPathComponent];
#endif
    return path;
}
static NSDictionary *readObject(NSString *path, NSUInteger limit) {
    if(!path.length)return @{};
    NSData *data=[NSData dataWithContentsOfFile:path];if(!data.length||data.length>limit)return @{};
    id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [value isKindOfClass:NSDictionary.class]?value:@{};
}
static BOOL saveObject(NSDictionary *object,NSString *path) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];if(!data)return NO;
    [[NSFileManager defaultManager] createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:NULL];
    NSDataWritingOptions options=NSDataWritingAtomic;
#if TARGET_OS_IPHONE
    options|=NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication;
#endif
    if(![data writeToFile:path options:options error:NULL])return NO;
    return chmod(path.fileSystemRepresentation,0600)==0;
}
static BOOL hexSecret(id value) {
    return [value isKindOfClass:NSString.class] && [value length]==64 &&
      [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location==NSNotFound;
}
static NSString *newNonce(void) {
    uint8_t bytes[32];if(SecRandomCopyBytes(kSecRandomDefault,sizeof(bytes),bytes))return nil;
    NSMutableString *value=[NSMutableString string];for(unsigned i=0;i<sizeof(bytes);i++)[value appendFormat:@"%02x",bytes[i]];return value;
}
static BOOL validIdentity(NSDictionary *value) {
    if(![value[@"domain"] isEqual:BROWSER_WEB_DOMAIN] || ![value[@"pkcs12Base64"] isKindOfClass:NSString.class])return NO;
    NSData *bytes=[[NSData alloc] initWithBase64EncodedString:value[@"pkcs12Base64"] options:0];NSString *message=nil;
    NSDictionary *validation=@{};
#ifdef SC_MANAGED_TEST
    NSString *anchor=NSProcessInfo.processInfo.environment[@"SC_MANAGED_TEST_ANCHOR"];
    if(anchor.length)validation=@{@"testAnchor":anchor};
#endif
    return showcase_web_identity_data(bytes,value[@"identityPassword"],validation,BROWSER_WEB_DOMAIN,&message)!=nil;
}
@interface SCManagedRequest:NSObject<NSURLSessionDataDelegate,NSURLSessionTaskDelegate>
@property(nonatomic,strong)NSURLSession *session;
@property(nonatomic,strong)NSMutableData *bytes;
@property(nonatomic,copy)void(^completion)(NSDictionary *,NSInteger);
@property NSInteger status;
@end
@implementation SCManagedRequest
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task willPerformHTTPRedirection:(NSHTTPURLResponse*)response newRequest:(NSURLRequest*)request completionHandler:(void(^)(NSURLRequest*))completion {
    (void)session;(void)task;(void)response;(void)request;completion(nil);
}
- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task didReceiveResponse:(NSURLResponse*)response completionHandler:(void(^)(NSURLSessionResponseDisposition))completion {
    (void)session;(void)task;self.status=[(NSHTTPURLResponse*)response statusCode];
    completion(response.expectedContentLength>400000?NSURLSessionResponseCancel:NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task didReceiveData:(NSData*)data {
    (void)session;if(self.bytes.length+data.length>400000){[task cancel];return;}[self.bytes appendData:data];
}
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task didCompleteWithError:(NSError*)error {
    (void)task;id value=!error?[NSJSONSerialization JSONObjectWithData:self.bytes options:0 error:NULL]:nil;
    self.completion([value isKindOfClass:NSDictionary.class]?value:nil,error?0:self.status);
    [session finishTasksAndInvalidate];self.completion=nil;self.session=nil;
}
@end
static void request(NSString *path,NSString *token,NSDictionary *body,void(^completion)(NSDictionary *,NSInteger)) {
    NSURL *url=[NSURL URLWithString:[BROWSER_MANAGED_ORIGIN stringByAppendingString:path]];
    NSMutableURLRequest *message=[NSMutableURLRequest requestWithURL:url];message.timeoutInterval=25;
    [message setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    if(token)[message setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
    if(body){message.HTTPMethod=@"POST";message.HTTPBody=[NSJSONSerialization dataWithJSONObject:body options:0 error:NULL];
        [message setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];}
    NSURLSessionConfiguration *configuration=[NSURLSessionConfiguration ephemeralSessionConfiguration];
#ifdef SC_MANAGED_TEST
    configuration.protocolClasses=@[NSClassFromString(@"SCManagedTestProtocol")];
#endif
    configuration.URLCache=nil;configuration.requestCachePolicy=NSURLRequestReloadIgnoringLocalCacheData;
    configuration.timeoutIntervalForResource=35;
    SCManagedRequest *delegate=[SCManagedRequest new];delegate.bytes=[NSMutableData data];delegate.completion=completion;
    delegate.session=[NSURLSession sessionWithConfiguration:configuration delegate:delegate delegateQueue:nil];
    [[delegate.session dataTaskWithRequest:message] resume];
}
NSString *showcase_managed_access_status(void) {
    @synchronized(SCManagedRequest.class){return managedStatus;}
}
void showcase_managed_access_refresh(NSString *profilePath,BOOL force,void(^completion)(BOOL,BOOL,BOOL)) {
    @synchronized(SCManagedRequest.class){if(busy||(!force&&NSDate.date.timeIntervalSince1970<nextCheck))return;busy=YES;}
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
        NSString *identityPath=privatePath(BROWSER_MANAGED_IDENTITY),*clientPath=privatePath(BROWSER_MANAGED_CLIENT),*configPath=privatePath(BROWSER_WEB_CONFIG);
        NSDictionary *cached=readObject(identityPath,400000),*client=readObject(clientPath,4096);
        BOOL usable=validIdentity(cached);NSMutableDictionary *state=[client mutableCopy];
        NSDictionary *profile=readObject(profilePath,4096);
        BOOL activated=!hexSecret(state[@"clientToken"])||(hexSecret(profile[@"activationId"])&&![state[@"activationId"] isEqual:profile[@"activationId"]]);
        void(^finish)(NSString *,BOOL,BOOL,BOOL)=^(NSString *status,BOOL ready,BOOL changed,BOOL paired){
            @synchronized(SCManagedRequest.class){managedStatus=status;busy=NO;nextCheck=NSDate.date.timeIntervalSince1970+(ready?21600:60);}
            dispatch_async(dispatch_get_main_queue(),^{if(completion)completion(ready,changed,paired);});
        };
        if(activated && (![profile[@"serviceURL"] isEqual:BROWSER_MANAGED_ORIGIN]||![profile[@"domain"] isEqual:BROWSER_WEB_DOMAIN]||!hexSecret(profile[@"activationCode"]))) {
            finish(@"自动热点接入：安装个人激活包后自动配置；域名和证书无需手动填写",usable,NO,NO);return;
        }
        if(activated&&!hexSecret(state[@"deviceNonce"])) {
            NSString *nonce=newNonce();if(!nonce){finish(@"自动接入：无法生成设备随机标识",usable,NO,NO);return;}
            state[@"deviceNonce"]=nonce;
            if(!saveObject(state,clientPath)){finish(@"自动接入：无法保存设备状态",usable,NO,NO);return;}
        }
        @synchronized(SCManagedRequest.class){managedStatus=activated?@"自动热点接入：正在激活并准备 HTTPS…":@"自动热点接入：正在检查证书更新…";}
        request(activated?@"/v1/activate":@"/v1/identity",activated?nil:state[@"clientToken"],
          activated?@{@"activationCode":profile[@"activationCode"],@"deviceNonce":state[@"deviceNonce"]}:nil,
          ^(NSDictionary *value,NSInteger status){
            if(status!=200||!value){
                NSString *failure=status==401||status==403?@"自动更新授权已失效：请安装新的个人激活包；有效的本机证书仍可使用":
                  usable?@"自动热点接入：使用本机证书，联网后自动重试更新":@"自动接入尚未就绪：检查网络或个人激活包是否已过期";
                finish(failure,usable,NO,NO);return;
            }
            if(!validIdentity(value)){finish(@"自动接入：新证书未通过域名及系统信任校验，未替换本机证书",usable,NO,NO);return;}
            if(activated){
                if(!hexSecret(value[@"clientToken"])){finish(@"自动接入：无效的设备授权响应",usable,NO,NO);return;}
                state[@"clientToken"]=value[@"clientToken"];
                if(hexSecret(profile[@"activationId"]))state[@"activationId"]=profile[@"activationId"];
                if([value[@"clientId"] isKindOfClass:NSString.class])state[@"clientId"]=value[@"clientId"];
                if(!saveObject(state,clientPath)){finish(@"自动接入：无法保存设备授权",usable,NO,NO);return;}
            }
            NSDictionary *identity=@{@"domain":BROWSER_WEB_DOMAIN,@"identityPassword":value[@"identityPassword"],
              @"pkcs12Base64":value[@"pkcs12Base64"],@"notAfter":value[@"notAfter"]?:@"",@"fingerprint":value[@"fingerprint"]?:@""};
            BOOL changed=![cached[@"pkcs12Base64"] isEqual:identity[@"pkcs12Base64"]];
            if(changed&&!saveObject(identity,identityPath)){finish(@"自动接入：无法保存证书，保留原证书",usable,NO,NO);return;}
            NSMutableDictionary *configuration=[readObject(configPath,8192) mutableCopy];
            BOOL domainChanged=![configuration[@"domain"] isEqual:BROWSER_WEB_DOMAIN];configuration[@"domain"]=BROWSER_WEB_DOMAIN;
            if(!saveObject(configuration,configPath)){finish(@"自动接入：无法更新网页配置",usable,NO,NO);return;}
            finish(@"自动热点接入已就绪：https://car.littlepond.eu.org/；证书自动更新",YES,changed||domainChanged,activated);
          });
    });
}
