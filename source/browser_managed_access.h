/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#import <Foundation/Foundation.h>
/* Call on launch/foreground and periodically. No credentials are returned to UI.
 * A personal installer may carry only a short-lived, one-use activation code. */
void showcase_managed_access_refresh(NSString *profilePath, BOOL force,
    void (^completion)(BOOL ready, BOOL changed, BOOL activated));
NSString *showcase_managed_access_status(void);
