/* SPDX-License-Identifier: GPL-3.0-or-later
 * Run the production bridge on macOS with synthetic/recorded AVC access units.
 * Fixture: BE32 avccLength, avcc, then repeated [BE32 length, AVCC frame].
 * stdin: b=background, f=foreground/new config, r=repeat same config, t=timestamp gap,
 * d=repeated timestamp, z=zero timestamp, n=normal timestamp,
 * s=static screen (no new frames), c=continue frames, q=quit.
 */
#import <Foundation/Foundation.h>
#include <unistd.h>
#include <fcntl.h>
#include "../source/browser_bridge.h"

static bool touch(uint8_t phase, uint16_t x, uint16_t y, uint8_t contact, uint64_t nanos) {
    (void)contact; (void)nanos;
    printf("TOUCH %u %u %u\n", phase, x, y); fflush(stdout); return true;
}
static void resync(void) { printf("KEY\n"); fflush(stdout); }
static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }

int main(int argc, char **argv) { @autoreleasepool {
    if (argc != 4) return 2;
    uint16_t port = (uint16_t)atoi(argv[1]);
    NSData *fixture = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
    if (fixture.length < 5) return 3;
    const uint8_t *p = fixture.bytes;
    uint32_t size = be32(p); if (size > fixture.length - 4) return 4;
    NSData *config = [fixture subdataWithRange:NSMakeRange(4, size)];
    NSMutableArray<NSData *> *frames = [NSMutableArray array];
    size_t at = 4 + size;
    while (at + 4 < fixture.length) {
        uint32_t length = be32(p + at); at += 4;
        if (!length || length > fixture.length - at) return 5;
        [frames addObject:[fixture subdataWithRange:NSMakeRange(at, length)]]; at += length;
    }
    if (!frames.count || at != fixture.length) return 6;
    if (!showcase_browser_start(port, touch, resync)) return 7;
    uint16_t width = 320, height = 180;
    if (sscanf(argv[3], "%hux%hu", &width, &height) != 2) return 8;
    showcase_browser_config(width, height, config.bytes, config.length);
    printf("READY\n"); fflush(stdout);
    fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
    uint64_t sequence = 0; bool active = true, run = true, flowing = true; char timing = 'n';
    while (run) { @autoreleasepool {
        char command[16]; ssize_t n = read(STDIN_FILENO, command, sizeof(command));
        for (ssize_t i = 0; i < n; i++) {
            if (command[i] == 'd' || command[i] == 'z' || command[i] == 'n') timing = command[i];
            if (command[i] == 'q') run = false;
            if (command[i] == 's') flowing = false;
            if (command[i] == 'c') flowing = true;
            if (command[i] == 'b') { active = false; showcase_browser_set_active(false); }
            if (command[i] == 't') sequence += 180; // long idle timestamp gap
            if (command[i] == 'r') showcase_browser_config(width, height, config.bytes, config.length);
            if (command[i] == 'f') {
                active = true; showcase_browser_set_active(true);
                showcase_browser_config(width, height, config.bytes, config.length);
                sequence = 0;
            }
        }
        if (active && flowing) {
            NSData *frame = frames[(NSUInteger)(sequence % frames.count)];
            const uint8_t *bytes = frame.bytes; bool key = false;
            for (size_t i = 0; i + 4 < frame.length;) {
                size_t count = be32(bytes + i); i += 4;
                if (!count || count > frame.length - i) break;
                key |= (bytes[i] & 31) == 5; i += count;
            }
            uint64_t time = (5ULL << 32) + sequence * 4294967296ULL / 30;
            showcase_browser_frame(timing == 'z' ? 0 : timing == 'd' ? (5ULL << 32) : time, key, frame.bytes, frame.length); sequence++;
        }
        usleep(33333);
    } }
    showcase_browser_stop(); return 0;
} }
