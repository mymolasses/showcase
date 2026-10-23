/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <stdint.h>
void showcase_rtc_start(uint32_t generation, NSData *avcc);
void showcase_rtc_signal(NSDictionary *message);
void showcase_rtc_frame(uint32_t generation, uint64_t micros, bool key, NSData *frame);
void showcase_rtc_stop(void);
NSArray<NSDictionary *> *showcase_rtc_events(void);
NSDictionary *showcase_rtc_stats(void);
