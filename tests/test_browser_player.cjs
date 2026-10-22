/* SPDX-License-Identifier: GPL-3.0-or-later */
const assert = require('node:assert/strict');
const {integer, initMp4, fragment, mapPoint, checkFrame} = require('../web/player.js');
const avcc = Uint8Array.from(Buffer.from('0142001effe100046742001e01000268ce', 'hex'));
const sample = Uint8Array.from(Buffer.from('0000000265b8', 'hex'));
function boxes(bytes) {
  let at = 0; const result = [];
  while (at < bytes.length) {
    const size = Buffer.from(bytes).readUInt32BE(at);
    assert(size >= 8 && at + size <= bytes.length);
    result.push({name: Buffer.from(bytes.slice(at + 4, at + 8)).toString(), at, size}); at += size;
  }
  assert.equal(at, bytes.length); return result;
}
const init = initMp4(avcc, 1280, 720);
assert.deepEqual(boxes(init).map(b => b.name), ['ftyp', 'moov']);
assert(Buffer.from(init).includes(Buffer.from('avcC')));
const frame = fragment(1, sample, true, 2 ** 32 + 90000, 3000);
const layout = boxes(frame); assert.deepEqual(layout.map(b => b.name), ['moof', 'mdat']);
const trun = Buffer.from(frame).indexOf('trun');
assert.equal(Buffer.from(frame).readUInt32BE(trun + 12), layout[0].size + 8);
const tfdt = Buffer.from(frame).indexOf('tfdt');
assert.equal(Number(Buffer.from(frame).readBigUInt64BE(tfdt + 8)), 2 ** 32 + 90000);
assert(checkFrame(sample));
assert.throws(() => checkFrame(Uint8Array.from([0, 0, 0, 2, 0x41, 0xa0])), /B 帧/);
assert.throws(() => checkFrame(sample.slice(0, -1)), /Invalid/);
assert.throws(() => integer(4, -1)); assert.throws(() => integer(4, 2 ** 32));
const rect = {left: 10, top: 20, width: 1000, height: 1000};
assert.deepEqual(mapPoint(rect, 1280, 720, 510, 520, false), {x: 640, y: 360});
assert.equal(mapPoint(rect, 1280, 720, 510, 30, false), null);
assert.deepEqual(mapPoint(rect, 1280, 720, -10, 2000, true), {x: 0, y: 720});
assert.equal(mapPoint({...rect, width: 0}, 1280, 720, 0, 0, false), null);
console.log('PASS: MP4 initialization, sample offsets, 64-bit time, AVC validation/B-frame refusal, letterbox touch mapping');

assert.deepEqual(mapPoint(rect, 1280, 720, 510, 30, false, true), {x: 640, y: 7});
assert.deepEqual(mapPoint(rect, 1280, 720, 10, 1020, false, true), {x: 0, y: 720});
