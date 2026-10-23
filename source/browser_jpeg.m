/* SPDX-License-Identifier: GPL-3.0-or-later
 * Bounded, off-thread VideoToolbox decode and JPEG encoding. Decode the full
 * reference chain, but encode at most 15 pictures/sec and 1280 pixels wide.
 */
#import "browser_jpeg.h"
#import <VideoToolbox/VideoToolbox.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#include <pthread.h>
#include <time.h>

static pthread_mutex_t jpegLock = PTHREAD_MUTEX_INITIALIZER;
static dispatch_queue_t queue;
static NSMutableArray<NSDictionary *> *pending;
static NSData *nextConfig;
static uint32_t nextGeneration, wantedGeneration, decodingGeneration;
static bool scheduled, needsKey = true, configurationPending;
static size_t pendingBytes;
static uint64_t encoded, decoded, dropped, errors;
static NSString *lastError;
static ShowcaseJPEGOutput publish;
static VTDecompressionSessionRef decoder;
static CMVideoFormatDescriptionRef format;
static double lastEncoded;

static double jpeg_now(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static void record_error(NSString *message) {
    pthread_mutex_lock(&jpegLock); errors++; lastError = message; needsKey = true;
    pthread_mutex_unlock(&jpegLock);
}
static void dispose_decoder(void) {
    if (decoder) {
        VTDecompressionSessionWaitForAsynchronousFrames(decoder);
        VTDecompressionSessionInvalidate(decoder); CFRelease(decoder); decoder = NULL;
    }
    if (format) { CFRelease(format); format = NULL; }
}
static void picture(void *unused, void *ref, OSStatus status, VTDecodeInfoFlags flags,
                    CVImageBufferRef image, CMTime pts, CMTime duration) {
    (void)unused; (void)ref; (void)flags; (void)duration;
    @autoreleasepool {
        if (status || !image) { record_error([NSString stringWithFormat:@"JPEG decoder: %d", (int)status]); return; }
        double now = jpeg_now();
        pthread_mutex_lock(&jpegLock);
        decoded++; bool current = wantedGeneration == decodingGeneration && publish;
        pthread_mutex_unlock(&jpegLock);
        if (!current || now - lastEncoded < 1.0 / 15) return;
        lastEncoded = now;
        CVPixelBufferLockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
        size_t width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image);
        CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
        CGContextRef original = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(image), width, height, 8,
            CVPixelBufferGetBytesPerRow(image), rgb, kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
        CGImageRef full = original ? CGBitmapContextCreateImage(original) : NULL;
        size_t outWidth = MIN(width, 1280), outHeight = MAX((size_t)1, height * outWidth / MAX(width, (size_t)1));
        CGContextRef scaled = full ? CGBitmapContextCreate(NULL, outWidth, outHeight, 8, outWidth * 4, rgb,
            kCGImageAlphaPremultipliedLast) : NULL;
        CGImageRef thumbnail = NULL;
        if (scaled) {
            CGContextSetInterpolationQuality(scaled, kCGInterpolationMedium);
            CGContextDrawImage(scaled, CGRectMake(0, 0, outWidth, outHeight), full);
            thumbnail = CGBitmapContextCreateImage(scaled);
        }
        NSMutableData *data = [NSMutableData data];
        CGImageDestinationRef destination = thumbnail ? CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data,
            CFSTR("public.jpeg"), 1, NULL) : NULL;
        bool success = false;
        if (destination) {
            NSDictionary *options = @{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.58};
            CGImageDestinationAddImage(destination, thumbnail, (__bridge CFDictionaryRef)options);
            success = CGImageDestinationFinalize(destination); CFRelease(destination);
        }
        if (thumbnail) CGImageRelease(thumbnail);
        if (scaled) CGContextRelease(scaled);
        if (full) CGImageRelease(full);
        if (original) CGContextRelease(original);
        CGColorSpaceRelease(rgb); CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
        if (!success || !data.length || data.length > 2 * 1024 * 1024) { record_error(@"JPEG encoding failed or image too large"); return; }
        pthread_mutex_lock(&jpegLock);
        current = wantedGeneration == decodingGeneration && publish;
        ShowcaseJPEGOutput output = publish; if (current) encoded++;
        pthread_mutex_unlock(&jpegLock);
        if (current) output(decodingGeneration, (uint64_t)MAX(0, CMTimeGetSeconds(pts) * 1000000), data);
    }
}
static bool configure_decoder(NSData *avcc) {
    const uint8_t *p = avcc.bytes; size_t size = avcc.length, at = 6;
    if (size < 7 || (p[4] & 3) != 3) return false;
    const uint8_t *parameters[64]; size_t lengths[64]; unsigned total = 0;
    for (unsigned group = 0; group < 2; group++) {
        unsigned count = group ? (at < size ? p[at++] : 0) : p[5] & 31;
        if (!count) return false;
        for (unsigned n = 0; n < count; n++) {
            if (at + 2 > size || total >= 64) return false;
            size_t length = ((size_t)p[at] << 8) | p[at + 1]; at += 2;
            if (!length || length > size - at) return false;
            parameters[total] = p + at; lengths[total++] = length; at += length;
        }
    }
    OSStatus status = CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault, total,
        parameters, lengths, 4, &format);
    if (status) return false;
    NSDictionary *attributes = @{(__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{}};
    VTDecompressionOutputCallbackRecord callback = {picture, NULL};
    status = VTDecompressionSessionCreate(kCFAllocatorDefault, format, NULL,
        (__bridge CFDictionaryRef)attributes, &callback, &decoder);
    return status == noErr;
}
static void run_worker(void) {
    for (;;) @autoreleasepool {
        pthread_mutex_lock(&jpegLock);
        bool configure = configurationPending;
        NSData *config = nextConfig; uint32_t next = nextGeneration;
        if (configure) { configurationPending = false; nextConfig = nil; }
        NSDictionary *frame = pending.firstObject;
        if (frame) { pendingBytes -= [frame[@"data"] length]; [pending removeObjectAtIndex:0]; }
        if (!configure && !frame) { scheduled = false; pthread_mutex_unlock(&jpegLock); return; }
        pthread_mutex_unlock(&jpegLock);
        if (configure) {
            dispose_decoder(); decodingGeneration = next; lastEncoded = -1;
            if (config && !configure_decoder(config)) record_error(@"Cannot initialize JPEG decoder");
        }
        if (!frame || !decoder || [frame[@"generation"] unsignedIntValue] != decodingGeneration) continue;
        NSData *data = frame[@"data"];
        CMBlockBufferRef block = NULL; CMSampleBufferRef sample = NULL;
        OSStatus status = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, NULL, data.length, kCFAllocatorDefault,
            NULL, 0, data.length, 0, &block);
        if (!status) status = CMBlockBufferReplaceDataBytes(data.bytes, block, 0, data.length);
        CMSampleTimingInfo timing = {kCMTimeInvalid, CMTimeMake([frame[@"time"] longLongValue], 1000000), kCMTimeInvalid};
        size_t length = data.length;
        if (!status) status = CMSampleBufferCreateReady(kCFAllocatorDefault, block, format, 1, 1, &timing, 1, &length, &sample);
        if (!status) status = VTDecompressionSessionDecodeFrame(decoder, sample, 0, NULL, NULL);
        if (sample) CFRelease(sample); if (block) CFRelease(block);
        if (status) record_error([NSString stringWithFormat:@"JPEG decode submission: %d", (int)status]);
    }
}
static void schedule_locked(void) {
    if (!queue) queue = dispatch_queue_create("showcase.jpeg", DISPATCH_QUEUE_SERIAL);
    if (!scheduled) { scheduled = true; dispatch_async(queue, ^{ run_worker(); }); }
}
void showcase_jpeg_configure(uint32_t generation, NSData *avcc, ShowcaseJPEGOutput output) {
    pthread_mutex_lock(&jpegLock);
    wantedGeneration = nextGeneration = generation; nextConfig = avcc; publish = output;
    configurationPending = true; needsKey = true; [pending removeAllObjects]; pendingBytes = 0;
    if (!pending) pending = [NSMutableArray array]; schedule_locked();
    pthread_mutex_unlock(&jpegLock);
}
bool showcase_jpeg_frame(uint32_t generation, uint64_t micros, bool key, NSData *frame) {
    pthread_mutex_lock(&jpegLock);
    if (generation != wantedGeneration || !publish) { pthread_mutex_unlock(&jpegLock); return false; }
    if (pending.count >= 12 || pendingBytes + frame.length > 8 * 1024 * 1024) {
        dropped += pending.count; [pending removeAllObjects]; pendingBytes = 0; needsKey = true;
    }
    if (needsKey && !key) { dropped++; pthread_mutex_unlock(&jpegLock); return false; }
    needsKey = false;
    [pending addObject:@{@"generation": @(generation), @"time": @(micros), @"data": frame}]; pendingBytes += frame.length;
    schedule_locked(); pthread_mutex_unlock(&jpegLock); return true;
}
void showcase_jpeg_reset(void) { showcase_jpeg_configure(0, nil, NULL); }
void showcase_jpeg_stop(void) {
    showcase_jpeg_reset();
    if (queue) dispatch_sync(queue, ^{ dispose_decoder(); });
}
NSDictionary *showcase_jpeg_stats(void) {
    pthread_mutex_lock(&jpegLock);
    NSDictionary *state = @{@"jpegEncodedFrames": @(encoded), @"jpegDecodedFrames": @(decoded),
        @"jpegDroppedInputs": @(dropped), @"jpegErrors": @(errors), @"jpegQueueBytes": @(pendingBytes),
        @"jpegLastError": lastError ?: @"", @"jpegMaxFps": @15, @"jpegMaxWidth": @1280};
    pthread_mutex_unlock(&jpegLock); return state;
}
