/* Test-only compiler injection. Production builds do not include this file.
 * Keep every VideoToolbox decode unavailable, as in the iOS device report;
 * successful pixels must therefore come from the independent CPU decoder. */
#import <VideoToolbox/VideoToolbox.h>
#define VTDecompressionSessionDecodeFrame(...) ((OSStatus)-12780)
