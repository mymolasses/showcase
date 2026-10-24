/* Include the production implementation in this test translation unit so
 * callback failures can be injected without adding a release-only test API. */
#import <VideoToolbox/VideoToolbox.h>
#include <stdatomic.h>
#include <stdbool.h>
static _Atomic bool forceHardwareFailure;
#define VTDecompressionSessionDecodeFrame(...) (atomic_load(&forceHardwareFailure) ? (OSStatus)-12780 : VTDecompressionSessionDecodeFrame(__VA_ARGS__))
#import "../source/browser_jpeg.m"
#include <assert.h>
#include <unistd.h>

static void output(uint32_t generation, uint64_t micros, NSData *image) {
    (void)generation; (void)micros; assert(image.length>100);
}
static uint32_t be32(const uint8_t *p) { return (uint32_t)p[0]<<24|(uint32_t)p[1]<<16|(uint32_t)p[2]<<8|p[3]; }
static bool is_key(NSData *data) {
    const uint8_t *p=data.bytes;
    for(size_t i=0;i+4<data.length;) {
        uint32_t length=be32(p+i); i+=4;
        if(!length || length>data.length-i) return false;
        if((p[i]&31)==5) return true;
        i+=length;
    }
    return false;
}
static void progress(NSArray<NSData *> *frames,uint32_t generation,uint64_t before) {
    double deadline=jpeg_now()+8;
    unsigned i=0;
    while([showcase_jpeg_stats()[@"jpegEncodedFrames"] unsignedLongLongValue]<=before+1) {
        assert(jpeg_now()<deadline);
        NSData *frame=frames[i%frames.count];
        showcase_jpeg_frame(generation,i*33333,is_key(frame),frame); i++;
        usleep(33333);
    }
}
int main(int argc,char **argv) { @autoreleasepool {
    assert(argc==2);
    NSData *fixture=[NSData dataWithContentsOfFile:@(argv[1])];
    assert(fixture.length>4);
    const uint8_t *bytes=fixture.bytes; uint32_t size=be32(bytes);
    assert(size<fixture.length-4);
    NSData *config=[fixture subdataWithRange:NSMakeRange(4,size)];
    NSMutableArray<NSData *> *frames=[NSMutableArray array];
    for(size_t i=4+size;i+4<fixture.length;) {
        size=be32(bytes+i);i+=4;assert(size && size<=fixture.length-i);
        [frames addObject:[fixture subdataWithRange:NSMakeRange(i,size)]];i+=size;
    }
    assert(frames.count>1 && is_key(frames[0]) && !is_key(frames[1]));
    showcase_jpeg_configure(1,config,output); progress(frames,1,0);
    uint64_t before=[showcase_jpeg_stats()[@"jpegEncodedFrames"] unsignedLongLongValue];
    dispatch_sync(queue,^{ picture(NULL,NULL,-12780,0,NULL,kCMTimeInvalid,kCMTimeInvalid); });
    assert(!showcase_jpeg_frame(1,0,false,frames[1]));
    progress(frames,1,before);
    assert([showcase_jpeg_stats()[@"jpegRecoveryCount"] unsignedIntValue]==1);
    assert([showcase_jpeg_stats()[@"jpegDecoderBackend"] isEqual:@"ffmpeg"]);
    assert([showcase_jpeg_stats()[@"jpegFallbackReason"] containsString:@"-12780"]);
    assert([showcase_jpeg_stats()[@"jpegPixelFormat"] unsignedIntValue]!=0);
    // Persistent creation failure exhausts a bounded recovery budget, instead
    // of creating a decoder on every input. A new config resets that budget.
    uint8_t invalid[]={1,77,0,42,255,225,0};
    showcase_jpeg_configure(2,[NSData dataWithBytes:invalid length:sizeof(invalid)],output);
    double deadline=jpeg_now()+8;
    while(![showcase_jpeg_stats()[@"jpegRecoveryExhausted"] boolValue]) {
        assert(jpeg_now()<deadline);
        showcase_jpeg_frame(2,0,true,frames[0]);usleep(100000);
    }
    assert([showcase_jpeg_stats()[@"jpegRecoveryCount"] unsignedIntValue]==4);
    before=[showcase_jpeg_stats()[@"jpegEncodedFrames"] unsignedLongLongValue];
    showcase_jpeg_configure(3,config,output);progress(frames,3,before);
    assert(!showcase_jpeg_frame(2,0,true,frames[0]));
    // One IDR followed by a static screen: even if every system decode fails,
    // replay that same IDR on CPU and flush its JPEG without further input.
    before=[showcase_jpeg_stats()[@"jpegEncodedFrames"] unsignedLongLongValue];
    atomic_store(&forceHardwareFailure,true);
    showcase_jpeg_configure(4,config,output);
    assert(showcase_jpeg_frame(4,0,true,frames[0]));
    deadline=jpeg_now()+5;
    while([showcase_jpeg_stats()[@"jpegEncodedFrames"] unsignedLongLongValue]<=before) {
        assert(jpeg_now()<deadline);usleep(10000);
    }
    assert([showcase_jpeg_stats()[@"jpegDecoderBackend"] isEqual:@"ffmpeg"]);
    showcase_jpeg_stop();
    puts("PASS: real JPEG, VT -12780 -> CPU H.264 pixels, bounded retries, new generation, stale input, single-IDR static screen fallback");
} }
