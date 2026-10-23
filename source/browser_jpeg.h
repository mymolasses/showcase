/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdbool.h>

typedef void (*ShowcaseJPEGOutput)(uint32_t generation, uint64_t micros, NSData *image);
void showcase_jpeg_configure(uint32_t generation, NSData *avcc, ShowcaseJPEGOutput output);
bool showcase_jpeg_frame(uint32_t generation, uint64_t micros, bool key, NSData *frame);
void showcase_jpeg_reset(void);
void showcase_jpeg_stop(void);
NSDictionary *showcase_jpeg_stats(void);
