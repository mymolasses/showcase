/* SPDX-License-Identifier: GPL-3.0-or-later. Test-only URLProtocol, no keychain writes. */
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#import "../source/browser_managed_access.h"

static NSData *responseBytes;
static NSInteger responseStatus=200;
static NSMutableArray<NSURLRequest *> *requests;
#define CHECK(value) do { if(!(value)){fprintf(stderr,"Managed access check failed at line %d\n",__LINE__);exit(1);} } while(0)

@interface SCManagedTestProtocol:NSURLProtocol @end
@implementation SCManagedTestProtocol
+(BOOL)canInitWithRequest:(NSURLRequest*)request { (void)request;return YES; }
+(NSURLRequest*)canonicalRequestForRequest:(NSURLRequest*)request { return request; }
-(void)startLoading {
    CHECK([self.request.URL.host isEqual:@"setup.littlepond.eu.org"]);
    [requests addObject:self.request];
    NSDictionary *headers=@{@"Content-Type":@"application/json",@"Content-Length":@(responseBytes.length).stringValue};
    NSHTTPURLResponse *response=[[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:responseStatus HTTPVersion:@"HTTP/1.1" headerFields:headers];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [self.client URLProtocol:self didLoadData:responseBytes];
    [self.client URLProtocolDidFinishLoading:self];
}
-(void)stopLoading {}
@end

static NSDictionary *loadFixtureObject(NSString *path){
    NSData *data=[NSData dataWithContentsOfFile:path];
    return data?[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]:nil;
}
static NSArray *refresh(NSString *profile){
    static unsigned sequence;fprintf(stderr,"[managed-test] refresh %u, HTTP %ld, bytes %lu\n",++sequence,(long)responseStatus,(unsigned long)responseBytes.length);
    __block NSArray *result=nil;
    showcase_managed_access_refresh(profile,YES,^(BOOL ready,BOOL changed,BOOL activated){result=@[@(ready),@(changed),@(activated)];});
    NSDate *deadline=[NSDate dateWithTimeIntervalSinceNow:12];
    while(!result&&deadline.timeIntervalSinceNow>0)[NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    CHECK(result!=nil);return result;
}
int main(int argc,const char **argv){@autoreleasepool{
    CHECK(argc==2);NSString *root=[NSString stringWithUTF8String:argv[1]];requests=[NSMutableArray array];
    NSString *profile=[root stringByAppendingPathComponent:@"activation.json"],*identity=[root stringByAppendingPathComponent:@"browser-managed-identity.json"],*client=[root stringByAppendingPathComponent:@"browser-managed-client.json"];
    NSDictionary *first=loadFixtureObject([root stringByAppendingPathComponent:@"first.json"]),*second=loadFixtureObject([root stringByAppendingPathComponent:@"second.json"]);
    CHECK(first&&second);
    // An invalid initial identity must never create a usable HTTPS cache/token.
    NSMutableDictionary *bad=[first mutableCopy];bad[@"identityPassword"]=@"wrong-password";
    responseBytes=[NSJSONSerialization dataWithJSONObject:bad options:0 error:NULL];
    CHECK(![refresh(profile)[0] boolValue]);CHECK(loadFixtureObject(identity)==nil);CHECK(loadFixtureObject(client)[@"clientToken"]==nil);
    responseBytes=[NSJSONSerialization dataWithJSONObject:first options:0 error:NULL];
    NSArray *initial=refresh(profile);CHECK([initial[0] boolValue]&&[initial[1] boolValue]&&[initial[2] boolValue]);
    NSDictionary *state=loadFixtureObject(client);CHECK([state[@"clientToken"] isEqual:first[@"clientToken"]]);CHECK([state[@"deviceNonce"] length]==64);
    CHECK([loadFixtureObject(identity)[@"pkcs12Base64"] isEqual:first[@"pkcs12Base64"]]);
    for(NSString *name in @[@"browser-managed-identity.json",@"browser-managed-client.json",@"browser-web.json"]){struct stat st;CHECK(!stat([[root stringByAppendingPathComponent:name] fileSystemRepresentation],&st));CHECK((st.st_mode&0777)==0600);}
    CHECK([loadFixtureObject([root stringByAppendingPathComponent:@"browser-web.json"])[@"domain"] isEqual:@"car.littlepond.eu.org"]);
    responseBytes=[NSJSONSerialization dataWithJSONObject:second options:0 error:NULL];
    NSArray *updated=refresh(profile);CHECK([updated[0] boolValue]&&[updated[1] boolValue]&&![updated[2] boolValue]);
    CHECK([requests.lastObject.URL.path isEqual:@"/v1/identity"]);
    CHECK([[requests.lastObject valueForHTTPHeaderField:@"Authorization"] isEqual:[@"Bearer " stringByAppendingString:first[@"clientToken"]]]);
    NSData *retained=[NSData dataWithContentsOfFile:identity];
    for(NSDictionary *invalid in @[@{@"domain":@"other.example"},bad]){
        responseBytes=[NSJSONSerialization dataWithJSONObject:invalid options:0 error:NULL];
        NSArray *result=refresh(profile);CHECK([result[0] boolValue]&&![result[1] boolValue]);CHECK([[NSData dataWithContentsOfFile:identity] isEqual:retained]);
    }
    responseBytes=[NSJSONSerialization dataWithJSONObject:second options:0 error:NULL];responseStatus=401;
    CHECK([refresh(profile)[0] boolValue]);CHECK([[NSData dataWithContentsOfFile:identity] isEqual:retained]);responseStatus=200;
    responseBytes=[NSMutableData dataWithLength:400001];CHECK(![refresh(profile)[1] boolValue]);CHECK([[NSData dataWithContentsOfFile:identity] isEqual:retained]);
    // URLProtocol redirect emulation does not reliably complete cancelled tasks
    // on macOS. Exercise the production NSURLSession redirect delegate itself.
    id<NSURLSessionTaskDelegate> redirectDelegate=[NSClassFromString(@"SCManagedRequest") new];
    __block BOOL refused=NO;
    [redirectDelegate URLSession:nil task:nil willPerformHTTPRedirection:nil
      newRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"https://attacker.invalid/identity"]]
      completionHandler:^(NSURLRequest *request){refused=request==nil;}];
    CHECK(refused);CHECK([[NSData dataWithContentsOfFile:identity] isEqual:retained]);
    CHECK(![showcase_managed_access_status() containsString:first[@"clientToken"]]);
    CHECK(![showcase_managed_access_status() containsString:first[@"identityPassword"]]);
    puts("PASS: native activation, trusted P12 rotation, 0600 cache, authenticated refresh, invalid identity/401/oversize/redirect preserve working certificate");
    return 0;
}}
