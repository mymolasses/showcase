/* SPDX-License-Identifier: GPL-3.0-or-later. Isolated legacy decoder. */
'use strict';
importScripts('/protocol.js', 'Decoder.js');
let decoder, busy = false, ready = false;
self.onmessage = event => {
  try {
    if (event.data.type === 'init') {
      decoder = new Decoder({rgb: true});
      decoder.onDecoderReady = () => { ready = true; self.postMessage({type:'ready'}); };
      decoder.onPictureDecoded = (pixels, width, height) => {
        if (width > 4096 || height > 4096 || width * height * 4 > pixels.length) throw Error('Invalid decoded picture');
        const copy = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, width * height * 4).slice();
        self.postMessage({type:'picture',pixels:copy,width,height},[copy.buffer]);
      };
    } else if (event.data.type === 'frame' && ready) {
      busy = true;
      const data = new Uint8Array(event.data.data);
      if (data.length > 4 * 1024 * 1024) throw Error('Software decoder input too large');
      decoder.decode(data);
      self.postMessage({type:'consumed'}); busy = false;
    }
  } catch (error) { self.postMessage({type:'error',message:error.message || String(error)}); }
};
