import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderLoop, RenderQuality, renderPixelRatio } from '../static/render-loop.js';

function loopHarness() {
  const callbacks = new Map(), draws = [];
  let id = 0;
  const state = { visible: true, playing: false };
  const loop = new RenderLoop({
    draw: now => draws.push(now), isPlaying: () => state.playing, isVisible: () => state.visible,
    requestFrame: callback => { callbacks.set(++id, callback); return id; },
    cancelFrame: key => callbacks.delete(key)
  });
  const flush = now => {
    const pending = [...callbacks.values()]; callbacks.clear();
    for (const callback of pending) callback(now);
  };
  return { loop, state, callbacks, draws, flush };
}

test('resize, seek and playback invalidations coalesce into one draw and paused views go idle', () => {
  const { loop, callbacks, draws, flush } = loopHarness();
  for (let i = 0; i < 50; i++) loop.invalidate();
  assert.equal(callbacks.size, 1);
  flush(16);
  assert.deepEqual(draws, [16]);
  assert.equal(callbacks.size, 0);
  loop.invalidate(); flush(32);
  assert.deepEqual(draws, [16, 32]);
  assert.equal(callbacks.size, 0);
});

test('continuous playback stops in a hidden view and resumes with the current frame timestamp', () => {
  const { loop, state, callbacks, draws, flush } = loopHarness();
  state.playing = true; loop.invalidate(); flush(16); flush(32);
  assert.equal(callbacks.size, 1);
  state.visible = false; loop.invalidate();
  assert.equal(callbacks.size, 0);
  flush(10000);
  assert.deepEqual(draws, [16, 32]);
  state.visible = true; loop.invalidate(); flush(20000);
  assert.deepEqual(draws, [16, 32, 20000]);
  assert.equal(callbacks.size, 1);
  state.playing = false; loop.invalidate(); flush(20016);
  assert.equal(callbacks.size, 0);
});

test('a queued frame checks visibility again before drawing', () => {
  const { loop, state, callbacks, draws, flush } = loopHarness();
  loop.invalidate(); state.visible = false; flush(16);
  assert.deepEqual(draws, []);
  assert.equal(callbacks.size, 0);
});

test('Performance mode resolution is bounded at high DPI and 4K without changing logical viewport size', () => {
  assert.equal(renderPixelRatio(800, 600, 1), 1);
  assert.equal(renderPixelRatio(800, 600, 3), 1.75);
  for (const [width, height] of [[1920, 1080], [3840, 2160], [7680, 4320]]) {
    const ratio = renderPixelRatio(width, height, 2);
    assert.ok(width * height * ratio * ratio <= 2_000_000 + 1e-8);
    assert.equal(renderPixelRatio(width, height, 2, .7), ratio * .7);
  }
});

test('quality responds to sustained missed frames, ignores suspension, and recovers slowly', () => {
  const quality = new RenderQuality();
  let now = 0;
  quality.sample(now);
  for (let i = 0; i < 120; i++) quality.sample(now += 1000 / 60);
  assert.equal(quality.scale, 1);
  quality.sample(now += 2000);
  assert.equal(quality.scale, 1);
  quality.reset(); quality.sample(now);
  for (let i = 0; i < 50; i++) quality.sample(now += 1000 / 30);
  assert.equal(quality.scale, .85);
  for (let i = 0; i < 300; i++) quality.sample(now += 1000 / 30);
  assert.equal(quality.scale, .55);
  quality.reset(); quality.sample(now);
  for (let i = 0; i < 600; i++) quality.sample(now += 1000 / 60);
  assert.equal(quality.scale, .55);
  for (let i = 0; i < 200; i++) quality.sample(now += 1000 / 60);
  assert.ok(quality.scale > .55 && quality.scale <= .61);
});

test('isolated slow frames do not lower quality or make it oscillate', () => {
  const quality = new RenderQuality();
  let now = 0;
  quality.sample(now);
  for (let i = 0; i < 1200; i++) quality.sample(now += i % 120 === 0 ? 100 : 1000 / 60);
  assert.equal(quality.scale, 1);
});
