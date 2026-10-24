/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <string.h>

typedef struct { uint16_t width, height; } SCDisplaySize;
/* Bound decoder load, preserve shape, and use even H.264 visible dimensions.
 * Do not round to macroblocks: a cropped H.264 frame need not be 16-aligned. */
static inline SCDisplaySize sc_display_fit(double width, double height) {
    SCDisplaySize empty = {0, 0};
    if (!isfinite(width) || !isfinite(height) || width < 240 || height < 240 ||
        width > 16384 || height > 16384 || width / height < 0.4 || width / height > 4) return empty;
    double scale = fmin(1, fmin(1920 / width, 1080 / height));
    return (SCDisplaySize){(uint16_t)(2 * lround(width * scale / 2)),
                           (uint16_t)(2 * lround(height * scale / 2))};
}
static inline SCDisplaySize sc_display_preset(const char *mode) {
    const struct { const char *name; uint16_t width, height; } presets[] = {
        {"1920x1080",1920,1080}, {"1600x900",1600,900}, {"1280x720",1280,720},
        {"1600x1000",1600,1000}, {"1440x1080",1440,1080}, {"1920x960",1920,960},
        {"1920x720",1920,720}
    };
    for (unsigned i=0; i<sizeof(presets)/sizeof(presets[0]); i++)
        if (mode && !strcmp(mode,presets[i].name)) return (SCDisplaySize){presets[i].width,presets[i].height};
    return (SCDisplaySize){0,0};
}
/* side: 0 full screen, 1 system safe area, 2 right island, 3 left island.
 * Explicit side modes reserve only the cutout edge, avoiding symmetric bars. */
typedef struct { double x,y,width,height; } SCDisplayRect;
static inline SCDisplayRect sc_phone_area(double width,double height,double top,double left,
                                          double bottom,double right,int side) {
    if (side==0) top=left=bottom=right=0;
    else if (side==2) { right=fmax(left,right); left=top=0; }
    else if (side==3) { left=fmax(left,right); right=top=0; }
    if (left+right>=width || top+bottom>=height) return (SCDisplayRect){0,0,width,height};
    return (SCDisplayRect){left,top,width-left-right,height-top-bottom};
}
static inline bool sc_display_touch(double vw,double vh,double cw,double ch,double x,double y,
                                     bool fill,bool clamp,uint16_t *outX,uint16_t *outY) {
    if (vw<=0 || vh<=0 || cw<=0 || ch<=0 || !isfinite(x) || !isfinite(y)) return false;
    if (!clamp && (x<0 || y<0 || x>vw || y>vh)) return false;
    x=fmax(0,fmin(vw,x)); y=fmax(0,fmin(vh,y));
    double scale=fill ? fmax(vw/cw,vh/ch) : fmin(vw/cw,vh/ch);
    double px=(x-(vw-cw*scale)/2)/scale, py=(y-(vh-ch*scale)/2)/scale;
    if (!clamp && (px<0 || py<0 || px>cw || py>ch)) return false;
    *outX=(uint16_t)lround(fmax(0,fmin(cw,px))); *outY=(uint16_t)lround(fmax(0,fmin(ch,py))); return true;
}
