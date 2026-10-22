/* Exercise production recovery against a media element stuck at a live edge,
 * including the short buffer (<650ms) the old latency-only seek missed. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
let now = 0, source, seeks = 0;
const intervals = [];
class Events {
  constructor() { this.handlers = {}; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  emit(name) { this.handlers[name]?.(); }
}
const video = Object.assign(new Events(), {
  position: 0, paused: false, seeking: false, playbackRate: 1,
  get currentTime() { return this.position; },
  play() { return Promise.resolve(); }, removeAttribute() {}, load() {},
  buffered: {length: 1, start: () => 0, end: () => 0.4}
});
Object.defineProperty(video, 'currentTime', {get() { return this.position; }, set(value) { this.position = value; seeks++; }});
class Source extends Events {
  static isTypeSupported() { return true; }
  constructor() { super(); source = this; }
  addSourceBuffer() { this.buffer = Object.assign(new Events(), {updating: false, appendBuffer() {}, remove() {}}); return this.buffer; }
}
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, Object.assign(new Events(), {hidden: false, textContent: ''}));
  return elements.get(id);
};
const context = {
  window: Object.assign(new Events(), {MediaSource: Source}),
  document: Object.assign(new Events(), {getElementById: element, querySelector: () => video}),
  URL: {createObjectURL: () => 'blob:test', revokeObjectURL() {}},
  performance: {now: () => now},
  setInterval: (fn, delay) => { intervals.push({fn, delay}); return intervals.length; },
  setTimeout: () => 1, clearInterval() {}, clearTimeout() {},
};
const script = fs.readFileSync(require.resolve('../web/player.js'), 'utf8').replace(/\r\n/g, '\n')
  .replace('  connect();\n})();', '  globalThis.createPlayer = makePlayer;\n})();');
vm.runInNewContext(script, context);
const player = context.createPlayer({avcc: Uint8Array.from(Buffer.from('0142001effe100046742001e01000268ce', 'hex')), width: 640, height: 360});
source.emit('sourceopen');
assert.equal(source.duration, Infinity);
const tick = intervals.find(t => t.delay === 250).fn;
now = 100; video.position = 0.1; tick(); // last observed playback progress
now = 1200; source.buffer.emit('updateend');
assert(seeks > 0, 'New frames with stalled currentTime must seek even below 650ms lag');
assert(Math.abs(video.currentTime - 0.25) < 0.001, 'Leave enough future frames after the recovery seek');
const after = seeks;
now = 5000; tick();
assert.equal(seeks, after, 'A static screen without new data must not keep seeking');
player.close();
console.log('PASS: embedded-browser short-buffer stall recovery, live duration, no static-screen seek loop');
