/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <ifaddrs.h>
#include <arpa/inet.h>
#include "display_geometry.h"

#define BROWSER_OUTPUT_KEY @"browserOutputEnabled"
#define BROWSER_QUALITY_KEY @"browserResolutionHeight"
#define BROWSER_PORT 8080
#define BROWSER_PROBE_KEY @"browserNetworkProbeEnabled"
#define BROWSER_PROBE_STATE @"/var/mobile/Library/Showcase/network-probe.json"
#define BROWSER_PROBE_PORT 8081
#define BROWSER_WEB_CONFIG @"/var/mobile/Library/Showcase/browser-web.json"
#define BROWSER_WEB_IDENTITY @"/var/mobile/Library/Showcase/browser-server.p12"
#define BROWSER_WEB_DOMAIN @"car.littlepond.eu.org"
#define BROWSER_MANAGED_ORIGIN @"https://setup.littlepond.eu.org"
#define BROWSER_MANAGED_IDENTITY @"/var/mobile/Library/Showcase/browser-managed-identity.json"
#define BROWSER_MANAGED_CLIENT @"/var/mobile/Library/Showcase/browser-managed-client.json"
#define BROWSER_DISPLAY_CONFIG @"/var/mobile/Library/Showcase/browser-display.json"
#define PHONE_ISLAND_KEY @"phoneIslandAvoidance"
#define PHONE_FILL_KEY @"phoneFillDisplay"

static NSDictionary *showcase_display_configuration(void) {
    NSData *data=[NSData dataWithContentsOfFile:BROWSER_DISPLAY_CONFIG];
    id config=data.length<=4096 ? [NSJSONSerialization JSONObjectWithData:data ?: [NSData data] options:0 error:NULL] : nil;
    return [config isKindOfClass:NSDictionary.class] ? config : @{};
}
static BOOL showcase_save_display_configuration(NSDictionary *config) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:config options:0 error:NULL];
    if (!data) return NO;
    [[NSFileManager defaultManager] createDirectoryAtPath:BROWSER_DISPLAY_CONFIG.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:NULL];
    BOOL saved=[data writeToFile:BROWSER_DISPLAY_CONFIG options:NSDataWritingAtomic error:NULL];
    if (saved) chmod(BROWSER_DISPLAY_CONFIG.fileSystemRepresentation,0644);
    return saved;
}

static BOOL showcase_web_domain_valid(NSString *domain) {
    if (![domain isKindOfClass:NSString.class] || domain.length > 253) return NO;
    NSString *pattern = @"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$";
    return [domain rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
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
