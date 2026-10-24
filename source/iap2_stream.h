/* RFCOMM carries a byte stream: one callback may contain several iAP2 packets,
 * or only part of one. Keep framing independent of the Bluetooth implementation. */
#ifndef SHOWCASE_IAP2_STREAM_H
#define SHOWCASE_IAP2_STREAM_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>

typedef struct {
    uint8_t bytes[65535];
    size_t used;
} SCIAP2Stream;
typedef void (*SCIAP2Packet)(uint8_t *packet, size_t length, void *context);

static inline int sc_iap2_checksum(const uint8_t *bytes, size_t length) {
    uint8_t sum = 0;
    for (size_t i = 0; i < length; i++) sum += bytes[i];
    return sum == 0;
}

static inline void sc_iap2_drain(SCIAP2Stream *stream, SCIAP2Packet receive, void *context) {
    static const uint8_t detect[] = {0xff, 0x55, 0x02, 0x00, 0xee, 0x10};
    size_t offset = 0;
    while (stream->used - offset >= 2) {
        uint8_t *packet = stream->bytes + offset;
        size_t available = stream->used - offset;
        if (packet[0] != 0xff) { offset++; continue; }
        if (packet[1] == 0x55) {
            size_t prefix = available < sizeof(detect) ? available : sizeof(detect);
            if (memcmp(packet, detect, prefix)) { offset++; continue; }
            if (available < sizeof(detect)) break;
            receive(packet, sizeof(detect), context);
            offset += sizeof(detect);
            continue;
        }
        if (packet[1] != 0x5a) { offset++; continue; }
        if (available < 9) break;
        size_t length = ((size_t)packet[2] << 8) | packet[3];
        if (length < 9 || !sc_iap2_checksum(packet, 9)) { offset++; continue; }
        if (available < length) break;
        if (length > 9 && !sc_iap2_checksum(packet + 9, length - 9)) { offset++; continue; }
        receive(packet, length, context);
        offset += length;
    }
    if (offset) {
        stream->used -= offset;
        memmove(stream->bytes, stream->bytes + offset, stream->used);
    }
}

static inline void sc_iap2_feed(SCIAP2Stream *stream, const uint8_t *bytes, size_t length,
                               SCIAP2Packet receive, void *context) {
    while (length) {
        size_t count = sizeof(stream->bytes) - stream->used;
        if (count > length) count = length;
        memcpy(stream->bytes + stream->used, bytes, count);
        stream->used += count;
        bytes += count;
        length -= count;
        sc_iap2_drain(stream, receive, context);
    }
}
#endif
