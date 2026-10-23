/* SPDX-License-Identifier: GPL-3.0-or-later
 * libdatachannel media-only H.264 sender; host ICE only, no STUN/TURN/cloud.
 * All library operations occur outside the bridge/CarPlay receiver thread.
 */
#import "browser_rtc.h"
#include <rtc/rtc.h>
#include <pthread.h>

static dispatch_queue_t rtcQueue;
static pthread_mutex_t rtcLock = PTHREAD_MUTEX_INITIALIZER;
static NSMutableArray<NSDictionary *> *events;
static uint32_t desiredGeneration, sessionGeneration;
static uint64_t epoch, sent, dropped;
static size_t queuedBytes;
static int peer = -1, track = -1;
static bool needKey = true, connected;
static NSData *parameterSets;
static NSString *lastError;

static void event_locked(NSDictionary *message) {
    if (!events) events = [NSMutableArray array];
    if (events.count < 32) [events addObject:message];
    else lastError = @"WebRTC signaling queue overflow";
}
static void local_description(int id, const char *sdp, const char *type, void *ptr) {
    (void)ptr;
    pthread_mutex_lock(&rtcLock);
    if (id == peer && sessionGeneration == desiredGeneration)
        event_locked(@{@"type":@"rtc-description", @"sdp":@(sdp), @"descriptionType":@(type), @"generation":@(sessionGeneration)});
    pthread_mutex_unlock(&rtcLock);
}
static void local_candidate(int id, const char *candidate, const char *mid, void *ptr) {
    (void)ptr;
    pthread_mutex_lock(&rtcLock);
    if (id == peer && sessionGeneration == desiredGeneration)
        event_locked(@{@"type":@"rtc-candidate", @"candidate":@(candidate), @"mid":@(mid), @"generation":@(sessionGeneration)});
    pthread_mutex_unlock(&rtcLock);
}
static void state_changed(int id, rtcState state, void *ptr) {
    (void)ptr;
    pthread_mutex_lock(&rtcLock);
    if (id == peer) {
        connected = state == RTC_CONNECTED;
        if (connected) event_locked(@{@"type":@"rtc-keyframe", @"generation":@(sessionGeneration)});
        if (state == RTC_FAILED) { lastError = @"WebRTC ICE/DTLS connection failed";
            event_locked(@{@"type":@"rtc-error", @"message":lastError, @"generation":@(sessionGeneration)}); }
    }
    pthread_mutex_unlock(&rtcLock);
}
static void pli(int id, void *ptr) {
    (void)id; (void)ptr;
    pthread_mutex_lock(&rtcLock); needKey = true;
    event_locked(@{@"type":@"rtc-keyframe", @"generation":@(sessionGeneration)});
    pthread_mutex_unlock(&rtcLock);
}
static void dispose_peer(void) {
    pthread_mutex_lock(&rtcLock);
    int oldPeer = peer, oldTrack = track; peer = track = -1; connected = false;
    pthread_mutex_unlock(&rtcLock);
    if (oldTrack >= 0) rtcDeleteTrack(oldTrack);
    if (oldPeer >= 0) rtcDeletePeerConnection(oldPeer);
}
static dispatch_queue_t work_queue(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{ rtcQueue = dispatch_queue_create("showcase.rtc", DISPATCH_QUEUE_SERIAL);
        rtcSetThreadPoolSize(2); rtcInitLogger(RTC_LOG_WARNING, NULL); });
    return rtcQueue;
}
static void error_event(NSString *message) {
    pthread_mutex_lock(&rtcLock); lastError = message;
    event_locked(@{@"type":@"rtc-error", @"message":message, @"generation":@(sessionGeneration)});
    pthread_mutex_unlock(&rtcLock);
}
void showcase_rtc_start(uint32_t generation, NSData *avcc) {
    pthread_mutex_lock(&rtcLock); desiredGeneration = generation; uint64_t ticket = ++epoch;
    [events removeAllObjects]; needKey = true; lastError = nil;
    pthread_mutex_unlock(&rtcLock);
    dispatch_async(work_queue(), ^{
        dispose_peer();
        pthread_mutex_lock(&rtcLock); bool current = ticket == epoch; pthread_mutex_unlock(&rtcLock);
        if (!current || avcc.length < 7) return;
        const uint8_t *p = avcc.bytes; size_t at = 6;
        NSMutableData *sets = [NSMutableData data];
        for (unsigned group = 0; group < 2; group++) {
            unsigned count = group ? (at < avcc.length ? p[at++] : 0) : p[5] & 31;
            for (unsigned i = 0; i < count; i++) {
                if (at + 2 > avcc.length) return;
                size_t length = ((size_t)p[at] << 8) | p[at+1]; at += 2;
                if (!length || length > avcc.length-at) return;
                uint8_t header[4] = {length>>24,length>>16,length>>8,length};
                [sets appendBytes:header length:4]; [sets appendBytes:p+at length:length]; at += length;
            }
        }
        parameterSets = sets;
        rtcConfiguration config = {0}; config.disableAutoNegotiation = true; config.forceMediaTransport = true;
        int created = rtcCreatePeerConnection(&config);
        if (created < 0) { error_event(@"Cannot initialize WebRTC peer"); return; }
        pthread_mutex_lock(&rtcLock); peer = created; sessionGeneration = generation; pthread_mutex_unlock(&rtcLock);
        rtcSetLocalDescriptionCallback(created, local_description); rtcSetLocalCandidateCallback(created, local_candidate);
        rtcSetStateChangeCallback(created, state_changed);
        NSString *profile = [NSString stringWithFormat:@"packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=%02x%02x%02x",p[1],p[2],p[3]];
        rtcTrackInit init = {0}; init.direction = RTC_DIRECTION_SENDONLY; init.codec = RTC_CODEC_H264;
        init.payloadType = 96; init.ssrc = 0x53484350; init.mid = "video"; init.name = "Showcase";
        init.msid = "showcase"; init.trackId = "carplay"; init.profile = profile.UTF8String;
        int mediaTrack = rtcAddTrackEx(created, &init);
        if (mediaTrack < 0) { error_event(@"Cannot create H.264 WebRTC track"); dispose_peer(); return; }
        pthread_mutex_lock(&rtcLock); track = mediaTrack; pthread_mutex_unlock(&rtcLock);
        rtcPacketizerInit packetizer = {0}; packetizer.ssrc = init.ssrc; packetizer.cname = "Showcase";
        packetizer.payloadType = 96; packetizer.clockRate = 90000; packetizer.maxFragmentSize = 1100;
        packetizer.nalSeparator = RTC_NAL_SEPARATOR_LENGTH;
        if (rtcSetH264Packetizer(mediaTrack,&packetizer) < 0 || rtcChainRtcpSrReporter(mediaTrack) < 0 ||
            rtcChainRtcpNackResponder(mediaTrack,128) < 0 || rtcChainPliHandler(mediaTrack,pli) < 0 ||
            rtcSetLocalDescription(created,"offer") < 0) error_event(@"Cannot configure WebRTC media sender");
    });
}
void showcase_rtc_signal(NSDictionary *message) {
    pthread_mutex_lock(&rtcLock); uint64_t ticket = epoch; pthread_mutex_unlock(&rtcLock);
    dispatch_async(work_queue(), ^{
        pthread_mutex_lock(&rtcLock); bool current = ticket == epoch && [message[@"generation"] unsignedIntValue] == sessionGeneration;
        int id = peer; pthread_mutex_unlock(&rtcLock);
        if (!current || id < 0) return;
        NSString *type = message[@"type"];
        int result = 0;
        if ([type isEqual:@"rtc-answer"]) result = rtcSetRemoteDescription(id,[message[@"sdp"] UTF8String],"answer");
        if ([type isEqual:@"rtc-candidate"]) result = rtcAddRemoteCandidate(id,[message[@"candidate"] UTF8String],[message[@"mid"] UTF8String]);
        if (result < 0) error_event(@"WebRTC signaling rejected");
    });
}
void showcase_rtc_frame(uint32_t generation, uint64_t micros, bool key, NSData *frame) {
    pthread_mutex_lock(&rtcLock);
    if (!connected || generation != desiredGeneration || (needKey && !key)) { pthread_mutex_unlock(&rtcLock); return; }
    if (queuedBytes + frame.length > 2 * 1024 * 1024) { needKey = true; dropped++;
        event_locked(@{@"type":@"rtc-keyframe", @"generation":@(generation)}); pthread_mutex_unlock(&rtcLock); return; }
    needKey = false; queuedBytes += frame.length; uint64_t ticket = epoch;
    pthread_mutex_unlock(&rtcLock);
    dispatch_async(work_queue(), ^{
        pthread_mutex_lock(&rtcLock); queuedBytes -= frame.length;
        bool current = ticket == epoch && connected; int id = track; pthread_mutex_unlock(&rtcLock);
        if (!current || id < 0 || !rtcIsOpen(id)) return;
        NSMutableData *data = [NSMutableData data]; if (key) [data appendData:parameterSets]; [data appendData:frame];
        rtcSetTrackRtpTimestamp(id,(uint32_t)(micros * 9 / 100));
        if (rtcSendMessage(id,data.bytes,(int)data.length) < 0) { pli(id,NULL); return; }
        pthread_mutex_lock(&rtcLock); sent++; pthread_mutex_unlock(&rtcLock);
    });
}
void showcase_rtc_stop(void) {
    pthread_mutex_lock(&rtcLock); ++epoch; desiredGeneration = 0; [events removeAllObjects]; pthread_mutex_unlock(&rtcLock);
    dispatch_async(work_queue(), ^{ dispose_peer(); parameterSets = nil; });
}
NSArray<NSDictionary *> *showcase_rtc_events(void) {
    pthread_mutex_lock(&rtcLock); NSArray *snapshot = [events copy] ?: @[]; [events removeAllObjects]; pthread_mutex_unlock(&rtcLock);
    return snapshot;
}
NSDictionary *showcase_rtc_stats(void) {
    pthread_mutex_lock(&rtcLock);
    NSDictionary *state = @{@"rtcConnected":@(connected), @"rtcSentFrames":@(sent), @"rtcDroppedInputs":@(dropped),
        @"rtcQueueBytes":@(queuedBytes), @"rtcLastError":lastError ?: @""};
    pthread_mutex_unlock(&rtcLock); return state;
}
