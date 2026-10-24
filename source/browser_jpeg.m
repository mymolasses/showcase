/* SPDX-License-Identifier: GPL-3.0-or-later
 * Bounded, off-thread VideoToolbox decode and JPEG encoding. Decode the full
 * reference chain, but encode at most 15 pictures/sec and 1280 pixels wide.
 */
#import "browser_jpeg.h"
#import <VideoToolbox/VideoToolbox.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <CoreImage/CoreImage.h>
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
#include <libswscale/swscale.h>
#include <pthread.h>
#include <time.h>
#include <math.h>

static pthread_mutex_t jpegLock = PTHREAD_MUTEX_INITIALIZER;
static dispatch_queue_t queue;
static NSMutableArray<NSDictionary *> *pending;
static NSData *nextConfig;
static uint32_t nextGeneration, wantedGeneration, decodingGeneration;
static bool scheduled, needsKey = true, configurationPending;
static size_t pendingBytes;
static uint64_t encoded, decoded, dropped, errors;
static NSString *lastError;
static OSStatus lastStatus;
static OSType pixelFormat;
static unsigned avcProfile, recoveryCount, consecutiveFailures;
static bool decoderFailed;
static double retryAfter;
static NSData *decoderConfig;
static CIContext *imageContext;
static AVCodecContext *softwareDecoder;
static struct SwsContext *converter;
static AVFrame *pendingSoftwareImage;
static bool useSoftware;
static NSString *fallbackReason;
static NSDictionary *lastFailure;
static ShowcaseJPEGOutput publish;
static VTDecompressionSessionRef decoder;
static CMVideoFormatDescriptionRef format;
static double lastEncoded;
static CVImageBufferRef pendingImage;
static CMTime pendingImageTime;
static uint32_t pendingImageGeneration;
static bool imageScheduled;
static uint64_t lastEncodedMicros;

static double jpeg_now(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static void record_error(NSString *message, OSStatus status, bool recover) {
    pthread_mutex_lock(&jpegLock); errors++; lastError = message; lastStatus = status;
    lastFailure = @{@"message":message,@"status":@(status),@"generation":@(decodingGeneration),
        @"backend":useSoftware ? @"ffmpeg" : @"videotoolbox",@"profile":@(avcProfile)};
    if (recover && wantedGeneration==decodingGeneration) {
        needsKey = decoderFailed = true;
        dropped += pending.count; [pending removeAllObjects]; pendingBytes = 0;
        if (pendingImage) { CVPixelBufferRelease(pendingImage); pendingImage = NULL; }
        av_frame_free(&pendingSoftwareImage);
    }
    pthread_mutex_unlock(&jpegLock);
}
static void dispose_decoder(void) {
    if (decoder) {
        VTDecompressionSessionWaitForAsynchronousFrames(decoder);
        VTDecompressionSessionInvalidate(decoder); CFRelease(decoder); decoder = NULL;
    }
    if (format) { CFRelease(format); format = NULL; }
    avcodec_free_context(&softwareDecoder);
    sws_freeContext(converter); converter = NULL;
}
static CVPixelBufferRef convert_software_picture(AVFrame *frame) {
    if (frame->width<=0 || frame->height<=0 || frame->width>4096 || frame->height>4096) return NULL;
    int width=MIN(frame->width,1280),height=MAX(1,frame->height*width/frame->width);
    CVPixelBufferRef image=NULL;
    if (CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,NULL,&image)) return NULL;
    if (CVPixelBufferLockBaseAddress(image,0)) { CVPixelBufferRelease(image); return NULL; }
    converter=sws_getCachedContext(converter,frame->width,frame->height,(enum AVPixelFormat)frame->format,
        width,height,AV_PIX_FMT_BGRA,SWS_BILINEAR,NULL,NULL,NULL);
    int rows=0;
    if (converter) {
        int color = frame->colorspace==AVCOL_SPC_BT709 ? SWS_CS_ITU709 :
            frame->colorspace==AVCOL_SPC_BT2020_NCL ? SWS_CS_BT2020 : SWS_CS_ITU601;
        const int *coefficients=sws_getCoefficients(color);
        sws_setColorspaceDetails(converter,coefficients,frame->color_range==AVCOL_RANGE_JPEG,
            coefficients,1,0,1<<16,1<<16);
        uint8_t *pixels[4]={CVPixelBufferGetBaseAddress(image),NULL,NULL,NULL};
        int strides[4]={(int)CVPixelBufferGetBytesPerRow(image),0,0,0};
        rows=sws_scale(converter,(const uint8_t *const *)frame->data,frame->linesize,0,frame->height,pixels,strides);
    }
    CVPixelBufferUnlockBaseAddress(image,0);
    if (rows!=height) { CVPixelBufferRelease(image); return NULL; }
    return image;
}
static void encode_picture(CVImageBufferRef image, CMTime pts, uint32_t stream) {
    @autoreleasepool {
        pthread_mutex_lock(&jpegLock);
        bool current = wantedGeneration == stream && publish;
        if (current) lastEncoded = jpeg_now();
        pthread_mutex_unlock(&jpegLock);
        if (!current) return;
        size_t width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image);
        CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
        /* Do not ask the H.264 decoder to convert to BGRA. Native output can
         * be NV12 (video/full range), including padded planes. Core Image
         * handles its color attachments/strides separately. A software
         * context also works in the root helper without a UIKit/GPU surface. */
        CGImageRef full=NULL;
        bool bgra=CVPixelBufferGetPixelFormatType(image)==kCVPixelFormatType_32BGRA;
        if (bgra) {
            CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly);
            CGContextRef context=CGBitmapContextCreate(CVPixelBufferGetBaseAddress(image),width,height,8,
                CVPixelBufferGetBytesPerRow(image),rgb,kCGBitmapByteOrder32Little|kCGImageAlphaPremultipliedFirst);
            full=context ? CGBitmapContextCreateImage(context) : NULL;
            if (context) CGContextRelease(context);
        } else {
            if (!imageContext) imageContext = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer:@YES}];
            CIImage *source = [CIImage imageWithCVPixelBuffer:image];
            full = [imageContext createCGImage:source fromRect:CGRectMake(0,0,width,height)];
        }
        CGSize visible = CMVideoFormatDescriptionGetPresentationDimensions(format,true,true);
        size_t visibleWidth = visible.width > 0 ? MIN(width,(size_t)llround(visible.width)) : width;
        size_t visibleHeight = visible.height > 0 ? MIN(height,(size_t)llround(visible.height)) : height;
        CGImageRef cropped = full ? CGImageCreateWithImageInRect(full,CGRectMake(0,0,visibleWidth,visibleHeight)) : NULL;
        size_t outWidth = MIN(visibleWidth, 1280), outHeight = MAX((size_t)1, visibleHeight * outWidth / MAX(visibleWidth, (size_t)1));
        CGContextRef scaled = full ? CGBitmapContextCreate(NULL, outWidth, outHeight, 8, outWidth * 4, rgb,
            kCGImageAlphaPremultipliedLast) : NULL;
        CGImageRef thumbnail = NULL;
        if (scaled) {
            CGContextSetInterpolationQuality(scaled, kCGInterpolationMedium);
            CGContextDrawImage(scaled, CGRectMake(0, 0, outWidth, outHeight), cropped ?: full);
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
        if (cropped) CGImageRelease(cropped);
        if (full) CGImageRelease(full);
        if (bgra) CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);
        CGColorSpaceRelease(rgb);
        if (!success || !data.length || data.length > 2 * 1024 * 1024) { record_error(@"JPEG pixel conversion/encoding failed or image too large",0,false); return; }
        pthread_mutex_lock(&jpegLock);
        current = wantedGeneration == stream && publish;
        uint64_t micros = (uint64_t)MAX(0,CMTimeConvertScale(pts,1000000,kCMTimeRoundingMethod_Default).value);
        ShowcaseJPEGOutput output = publish; if (current) { encoded++; lastEncodedMicros = micros; }
        pthread_mutex_unlock(&jpegLock);
        if (current) output(stream, micros, data);
    }
}
static void queue_picture(CVImageBufferRef image,AVFrame *software,CMTime pts) {
    AVFrame *copy = software ? av_frame_clone(software) : NULL;
    if (software && !copy) { record_error(@"JPEG CPU picture allocation failed",AVERROR(ENOMEM),false); return; }
    pthread_mutex_lock(&jpegLock); decoded++;
    if (wantedGeneration != decodingGeneration || !publish) { pthread_mutex_unlock(&jpegLock); av_frame_free(&copy); return; }
    pixelFormat = image ? CVPixelBufferGetPixelFormatType(image) : kCVPixelFormatType_32BGRA;
    consecutiveFailures = 0; decoderFailed = false;
    if (pendingImage) CVPixelBufferRelease(pendingImage);
    av_frame_free(&pendingSoftwareImage);
    pendingImage = image ? CVPixelBufferRetain(image) : NULL;
    pendingSoftwareImage = copy;
    pendingImageTime = pts; pendingImageGeneration = decodingGeneration;
    if (!imageScheduled) {
        imageScheduled = true;
        double wait = MAX(0,lastEncoded + 1.0/15 - jpeg_now());
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)(wait*NSEC_PER_SEC)),queue,^{
            pthread_mutex_lock(&jpegLock);
            CVImageBufferRef latest = pendingImage; CMTime time = pendingImageTime; uint32_t stream = pendingImageGeneration;
            AVFrame *software = pendingSoftwareImage; pendingSoftwareImage = NULL;
            pendingImage = NULL; imageScheduled = false;
            pthread_mutex_unlock(&jpegLock);
            if (software) {
                latest=convert_software_picture(software); av_frame_free(&software);
                if (!latest) record_error(@"JPEG CPU color conversion failed",0,false);
            }
            if (latest) { encode_picture(latest,time,stream); CVPixelBufferRelease(latest); }
        });
    }
    pthread_mutex_unlock(&jpegLock);
}
static void picture(void *unused, void *ref, OSStatus status, VTDecodeInfoFlags flags,
                    CVImageBufferRef image, CMTime pts, CMTime duration) {
    (void)unused; (void)ref; (void)duration;
    if (status) { record_error([NSString stringWithFormat:@"JPEG decoder output: %d",(int)status],status,true); return; }
    if (!image) {
        if (!(flags & kVTDecodeInfo_FrameDropped)) record_error(@"JPEG decoder returned no image",0,true);
        return;
    }
    queue_picture(image,NULL,pts);
}
static OSStatus configure_software(NSData *avcc) {
    const AVCodec *codec=avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec || !(softwareDecoder=avcodec_alloc_context3(codec))) return AVERROR(ENOMEM);
    softwareDecoder->thread_count=2; softwareDecoder->thread_type=FF_THREAD_SLICE;
    softwareDecoder->max_pixels=4096LL*4096;
    softwareDecoder->pkt_timebase=(AVRational){1,1000000};
    softwareDecoder->extradata=av_mallocz(avcc.length+AV_INPUT_BUFFER_PADDING_SIZE);
    if (!softwareDecoder->extradata) return AVERROR(ENOMEM);
    memcpy(softwareDecoder->extradata,avcc.bytes,avcc.length); softwareDecoder->extradata_size=(int)avcc.length;
    return avcodec_open2(softwareDecoder,codec,NULL);
}
static void decode_software(NSData *data,int64_t micros,bool key) {
    AVPacket *packet=av_packet_alloc(); AVFrame *frame=av_frame_alloc();
    int error = packet && frame ? av_new_packet(packet,(int)data.length) : AVERROR(ENOMEM);
    if (!error) {
        memcpy(packet->data,data.bytes,data.length); packet->pts=packet->dts=micros;
        if (key) packet->flags|=AV_PKT_FLAG_KEY;
        error=avcodec_send_packet(softwareDecoder,packet);
    }
    av_packet_free(&packet);
    if (!error) {
        while ((error=avcodec_receive_frame(softwareDecoder,frame))==0) {
            int64_t stamp=frame->pts==AV_NOPTS_VALUE ? micros : frame->pts;
            queue_picture(NULL,frame,CMTimeMake(stamp,1000000)); av_frame_unref(frame);
        }
        if (error==AVERROR(EAGAIN) || error==AVERROR_EOF) error=0;
    }
    av_frame_free(&frame);
    if (error) { char text[AV_ERROR_MAX_STRING_SIZE]; av_strerror(error,text,sizeof(text));
        record_error([NSString stringWithFormat:@"JPEG CPU H.264 decoder: %s",text],error,true); }
}
static OSStatus configure_decoder(NSData *avcc) {
    const uint8_t *p = avcc.bytes; size_t size = avcc.length, at = 6;
    if (size < 7 || (p[4] & 3) != 3) return kCMFormatDescriptionError_InvalidParameter;
    const uint8_t *parameters[64]; size_t lengths[64]; unsigned total = 0;
    for (unsigned group = 0; group < 2; group++) {
        unsigned count = group ? (at < size ? p[at++] : 0) : p[5] & 31;
        if (!count) return kCMFormatDescriptionError_InvalidParameter;
        for (unsigned n = 0; n < count; n++) {
            if (at + 2 > size || total >= 64) return kCMFormatDescriptionError_InvalidParameter;
            size_t length = ((size_t)p[at] << 8) | p[at + 1]; at += 2;
            if (!length || length > size - at) return kCMFormatDescriptionError_InvalidParameter;
            parameters[total] = p + at; lengths[total++] = length; at += length;
        }
    }
    OSStatus status = CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault, total,
        parameters, lengths, 4, &format);
    if (status) return status;
    if (useSoftware) return configure_software(avcc);
    VTDecompressionOutputCallbackRecord callback = {picture, NULL};
    status = VTDecompressionSessionCreate(kCFAllocatorDefault, format, NULL,
        NULL, &callback, &decoder);
    return status;
}
static void run_worker(void) {
    unsigned batch = 0;
    for (;;) @autoreleasepool {
        if (++batch > (useSoftware ? 2 : 8)) { dispatch_async(queue,^{ run_worker(); }); return; }
        pthread_mutex_lock(&jpegLock);
        bool configure = configurationPending;
        NSData *config = nextConfig; uint32_t next = nextGeneration;
        if (configure) { configurationPending = false; nextConfig = nil; }
        NSDictionary *frame = pending.firstObject;
        if (frame) { pendingBytes -= [frame[@"data"] length]; [pending removeObjectAtIndex:0]; }
        if (!configure && !frame) { scheduled = false; pthread_mutex_unlock(&jpegLock); return; }
        pthread_mutex_unlock(&jpegLock);
        if (configure) {
            dispose_decoder();
            decoderConfig = config;
            pthread_mutex_lock(&jpegLock); decodingGeneration = next; lastEncoded = -1;
            decoderFailed = false; consecutiveFailures = 0; retryAfter = 0; pixelFormat = 0;
            useSoftware=false; fallbackReason=nil;
            avcProfile = config.length > 1 ? ((const uint8_t *)config.bytes)[1] : 0;
            lastError = nil; lastStatus = 0;
            pthread_mutex_unlock(&jpegLock);
            OSStatus error = config ? configure_decoder(config) : noErr;
            if (error) record_error([NSString stringWithFormat:@"JPEG decoder creation: %d",(int)error],error,true);
        }
        if (!frame || [frame[@"generation"] unsignedIntValue] != decodingGeneration) continue;
        pthread_mutex_lock(&jpegLock);
        bool failed = decoderFailed;
        bool recover = failed && [frame[@"key"] boolValue] && consecutiveFailures < 3 && jpeg_now() >= retryAfter;
        if (recover) {
            recoveryCount++; consecutiveFailures++; retryAfter = jpeg_now()+2; decoderFailed = false;
            if (!useSoftware) { fallbackReason=lastError ?: @"VideoToolbox unavailable"; useSoftware=true; }
        }
        if (failed && !recover) { needsKey = true; dropped++; }
        pthread_mutex_unlock(&jpegLock);
        if (failed && !recover) continue;
        if (recover) {
            dispose_decoder();
            OSStatus error = configure_decoder(decoderConfig);
            if (error) { record_error([NSString stringWithFormat:@"JPEG decoder recovery: %d",(int)error],error,true); continue; }
        }
        if (useSoftware) {
            if (softwareDecoder) decode_software(frame[@"data"],[frame[@"time"] longLongValue],[frame[@"key"] boolValue]);
            continue;
        }
        if (!decoder) continue;
        NSData *data = frame[@"data"];
        CMBlockBufferRef block = NULL; CMSampleBufferRef sample = NULL;
        OSStatus status = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, NULL, data.length, kCFAllocatorDefault,
            NULL, 0, data.length, 0, &block);
        if (!status) status = CMBlockBufferReplaceDataBytes(data.bytes, block, 0, data.length);
        CMSampleTimingInfo timing = {kCMTimeInvalid, CMTimeMake([frame[@"time"] longLongValue], 1000000), kCMTimeInvalid};
        size_t length = data.length;
        if (!status) status = CMSampleBufferCreateReady(kCFAllocatorDefault, block, format, 1, 1, &timing, 1, &length, &sample);
        if (!status) {
            CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample,true);
            if (attachments && CFArrayGetCount(attachments)) CFDictionarySetValue(
                (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments,0),kCMSampleAttachmentKey_NotSync,
                [frame[@"key"] boolValue] ? kCFBooleanFalse : kCFBooleanTrue);
        }
        if (!status) status = VTDecompressionSessionDecodeFrame(decoder, sample, 0, NULL, NULL);
        if (sample) CFRelease(sample); if (block) CFRelease(block);
        if (status) record_error([NSString stringWithFormat:@"JPEG decode submission: %d", (int)status],status,true);
        /* The first IDR is still owned here. Replay it through the CPU
         * decoder immediately after a synchronous VT failure, rather than
         * losing the only keyframe of a mostly-static CarPlay screen. */
        pthread_mutex_lock(&jpegLock);
        bool fallbackNow=decoderFailed && !useSoftware && wantedGeneration==decodingGeneration && publish && [frame[@"key"] boolValue];
        if (fallbackNow) {
            fallbackReason=lastError; useSoftware=true; decoderFailed=false; needsKey=false;
            recoveryCount++; consecutiveFailures++; retryAfter=jpeg_now()+2;
        }
        pthread_mutex_unlock(&jpegLock);
        if (fallbackNow) {
            dispose_decoder(); OSStatus error=configure_decoder(decoderConfig);
            if (error) record_error([NSString stringWithFormat:@"JPEG CPU decoder creation: %d",(int)error],error,true);
            else decode_software(data,[frame[@"time"] longLongValue],true);
        }
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
    if (pendingImage) { CVPixelBufferRelease(pendingImage); pendingImage = NULL; }
    av_frame_free(&pendingSoftwareImage);
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
    [pending addObject:@{@"generation": @(generation), @"time": @(micros), @"key":@(key), @"data": frame}]; pendingBytes += frame.length;
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
        @"jpegLastError": lastError ?: @"", @"jpegMaxFps": @15, @"jpegMaxWidth": @1280,
        @"jpegLastStatus":@(lastStatus), @"jpegPixelFormat":@(pixelFormat), @"jpegAVCProfile":@(avcProfile),
        @"jpegRecoveryCount":@(recoveryCount), @"jpegRecoveryExhausted":@(decoderFailed && consecutiveFailures>=3),
        @"jpegDecoderBackend":wantedGeneration ? (useSoftware ? @"ffmpeg" : @"videotoolbox") : @"inactive",
        @"jpegFallbackReason":fallbackReason ?: @"", @"jpegLastFailure":lastFailure ?: @{},
        @"jpegLastEncodedMicros":@(lastEncodedMicros), @"jpegImagePending":@(pendingImage!=NULL || pendingSoftwareImage!=NULL)};
    pthread_mutex_unlock(&jpegLock); return state;
}
