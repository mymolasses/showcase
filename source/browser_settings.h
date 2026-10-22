/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <ifaddrs.h>
#include <arpa/inet.h>

#define BROWSER_OUTPUT_KEY @"browserOutputEnabled"
#define BROWSER_QUALITY_KEY @"browserResolutionHeight"
#define BROWSER_TOKEN_PATH @"/var/mobile/Library/Showcase/browser-token"
#define BROWSER_PORT 8080
#define BROWSER_PROBE_KEY @"browserNetworkProbeEnabled"
#define BROWSER_PROBE_STATE @"/var/mobile/Library/Showcase/network-probe.json"
#define BROWSER_PROBE_PORT 8081
#define BROWSER_WEB_CONFIG @"/var/mobile/Library/Showcase/browser-web.json"
#define BROWSER_WEB_IDENTITY @"/var/mobile/Library/Showcase/browser-server.p12"
#define BROWSER_WEB_DOMAIN @"carplay.99-99-99-99.sslip.io"

static BOOL showcase_web_domain_valid(NSString *domain) {
    if (![domain isKindOfClass:NSString.class] || domain.length > 253) return NO;
    NSString *pattern = @"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$";
    return [domain rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
}

/* Shared by the UI and service; the token is never placed in argv or logs. */
static NSString *showcase_browser_token(BOOL create) {
    NSString *token = [[NSString stringWithContentsOfFile:BROWSER_TOKEN_PATH
        encoding:NSUTF8StringEncoding error:NULL]
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSCharacterSet *digits = [NSCharacterSet characterSetWithCharactersInString:@"0123456789"];
    if (token.length == 4 && [token rangeOfCharacterFromSet:digits.invertedSet].location == NSNotFound) {
        chmod(BROWSER_TOKEN_PATH.fileSystemRepresentation, 0600);
        return token;
    }
    if (!create) return nil;
    NSString *value = [NSString stringWithFormat:@"%04u", arc4random_uniform(10000)];
    [[NSFileManager defaultManager] createDirectoryAtPath:BROWSER_TOKEN_PATH.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:NULL];
    NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
    if (![[NSFileManager defaultManager] createFileAtPath:BROWSER_TOKEN_PATH contents:bytes
        attributes:@{NSFilePosixPermissions: @0600}]) return nil;
    return value;
}

static NSString *showcase_browser_addresses(void) {
    struct ifaddrs *addresses = NULL;
    NSMutableArray *urls = [NSMutableArray array];
    if (getifaddrs(&addresses) != 0) return @"Hotspot address unavailable";
    for (struct ifaddrs *a = addresses; a; a = a->ifa_next) {
        if (!a->ifa_addr || a->ifa_addr->sa_family != AF_INET ||
            strncmp(a->ifa_name, "bridge", 6) != 0) continue;
        char ip[INET_ADDRSTRLEN];
        struct sockaddr_in *v4 = (struct sockaddr_in *)a->ifa_addr;
        if (inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof(ip)))
            [urls addObject:[NSString stringWithFormat:@"http://%s:%d", ip, BROWSER_PORT]];
    }
    freeifaddrs(addresses);
    return urls.count ? [urls componentsJoinedByString:@"\n"] : @"Start CarPlay to show the hotspot address";
}
