/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

typedef bool (*ShowcaseBrowserTouch)(uint8_t phase, uint16_t x, uint16_t y,
                                    uint8_t contact, uint64_t hostNanos);
typedef void (*ShowcaseBrowserResync)(void);
typedef bool (*ShowcaseBrowserDisplay)(const char *mode, uint16_t width, uint16_t height,
                                      uint16_t viewportWidth, uint16_t viewportHeight);
void showcase_browser_display_handler(ShowcaseBrowserDisplay callback, uint16_t width, uint16_t height,
                                      uint16_t phoneWidth, uint16_t phoneHeight);
void showcase_browser_phone_size(uint16_t width, uint16_t height);
void showcase_browser_reload_display(void);

/* Foreground prototype. Media is copied into bounded queues; these calls never
 * write to a browser socket on the CarPlay receiver thread. */
bool showcase_browser_start(uint16_t port,
                            ShowcaseBrowserTouch touch,
                            ShowcaseBrowserResync resync);
void showcase_browser_stop(void);
void showcase_browser_set_active(bool active);
void showcase_browser_reset(void);
void showcase_browser_config(uint16_t width, uint16_t height,
                             const uint8_t *avcc, size_t length);
void showcase_browser_frame(uint64_t senderTime32_32, bool key,
                            const uint8_t *avccFrame, size_t length);
/* Local and browser gestures share the same lock and HID callback. The most
 * recent down cancels the previous owner's gesture; idle viewers own nothing. */
bool showcase_browser_local_touch(uint8_t phase, uint16_t x, uint16_t y,
                                  uint8_t contact, uint64_t hostNanos);
