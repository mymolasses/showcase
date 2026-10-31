/* SPDX-License-Identifier: GPL-3.0-or-later */
((root) => {
  'use strict';
  function mapPoint(rect, width, height, x, y, clamp, fill = false) {
    if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) return null;
    const scale = (fill ? Math.max : Math.min)(rect.width / width, rect.height / height);
    let px = (x - rect.left - (rect.width - width * scale) / 2) / scale;
    let py = (y - rect.top - (rect.height - height * scale) / 2) / scale;
    if (!clamp && (px < 0 || px > width || py < 0 || py > height)) return null;
    return {x: Math.round(Math.max(0, Math.min(width, px))), y: Math.round(Math.max(0, Math.min(height, py)))};
  }
  function nals(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), units = [];
    let at = 0;
    while (at + 4 < bytes.length) {
      const length = view.getUint32(at); at += 4;
      if (!length || length > bytes.length - at) throw Error('Invalid AVC frame');
      units.push(bytes.subarray(at, at + length)); at += length;
    }
    if (at !== bytes.length || !units.length) throw Error('Invalid AVC frame');
    return units;
  }
  function parameterSets(avcc) {
    if (avcc.length < 7 || avcc[0] !== 1 || (avcc[4] & 3) !== 3) throw Error('Invalid AVC configuration');
    const result = []; let at = 6;
    for (let group = 0; group < 2; group++) {
      const count = group ? avcc[at++] : avcc[5] & 31;
      if (!count) throw Error('Missing AVC parameters');
      for (let i = 0; i < count; i++) {
        if (at + 2 > avcc.length) throw Error('Invalid AVC parameters');
        const size = avcc[at++] * 256 + avcc[at++];
        if (!size || size > avcc.length - at || (avcc[at] & 31) !== (group ? 8 : 7)) throw Error('Invalid AVC parameters');
        result.push(avcc.slice(at, at + size)); at += size;
      }
    }
    return result;
  }
  function annexB(units) {
    const data = new Uint8Array(units.reduce((size, nal) => size + 4 + nal.length, 0));
    let at = 0;
    for (const nal of units) { data.set([0,0,0,1], at); data.set(nal, at + 4); at += 4 + nal.length; }
    return data;
  }
  function uint64(view, at) {
    const value = view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
    if (!Number.isSafeInteger(value)) throw Error('Unsafe media counter');
    return value;
  }
  function parsePacket(data) {
    const bytes = new Uint8Array(data), view = new DataView(data);
    if (bytes[0] === 3 && bytes.length === 5) return {type:'reset', generation:view.getUint32(1)};
    if (bytes[0] === 1 && bytes.length >= 16) {
      const config = {generation:view.getUint32(1),width:view.getUint16(5),height:view.getUint16(7),avcc:bytes.slice(9)};
      if (!config.width || !config.height || config.width > 4096 || config.height > 4096) throw Error('Invalid display size');
      parameterSets(config.avcc); return {type:'config',config};
    }
    if (bytes[0] === 2 && bytes.length > 14) {
      const frame = bytes.subarray(14); const key = nals(frame).some(nal => (nal[0] & 31) === 5);
      if ((bytes[5] === 1) !== key) throw Error('Invalid keyframe flag');
      return {type:'avc',generation:view.getUint32(1),key,micros:uint64(view,6),bytes:frame};
    }
    throw Error('Invalid browser media packet');
  }
  function displaySize(width,height) {
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<240||height<240||width>16384||height>16384)return null;
    const scale=Math.min(1,4096/width,4096/height,Math.sqrt(3840*2160/(width*height)));
    return {width:2*Math.floor(width*scale/2),height:2*Math.floor(height*scale/2)};
  }
  function customDisplaySize(width,height) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<240||height<240||width>4096||height>4096||width%2||height%2||width*height>3840*2160||width/height<.4||width/height>4)return null;
    return {width,height};
  }
  function normalizeLandscapeRatio(value) {
    if(!Number.isFinite(value)||value<=0)return null;
    const rounded=Math.round(value*100)/100;
    return Number.isFinite(rounded)&&rounded>0?rounded:null;
  }
  function autoDisplaySize(width,height,minAspect=0) {
    const size=displaySize(width,height);
    if(!size)return null;
    if(minAspect!==0){minAspect=normalizeLandscapeRatio(minAspect);if(minAspect===null)return null;}
    const scale=Math.min(1,1920/size.width);
    const result={width:2*Math.floor(size.width*scale/2),height:2*Math.floor(size.height*scale/2)};
    if(minAspect>0)result.height=Math.min(result.height,2*Math.floor(result.width/minAspect/2));
    return result.height>=240?result:null;
  }
  const api = {mapPoint,nals,parameterSets,annexB,parsePacket,displaySize,customDisplaySize,autoDisplaySize,normalizeLandscapeRatio};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShowcaseProtocol = api;
})(typeof self !== 'undefined' ? self : globalThis);
