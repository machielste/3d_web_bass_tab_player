import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../static/playback-clock.js';
import { noteDepth } from '../static/timeline.js';

test('display-time motion suppresses quantized media steps while staying close to the audio', () => {
  const clock = new PlaybackClock();
  let previousRaw = null, previousVisual = null, rawError = 0, visualError = 0;
  for (let i = 0; i < 2000; i++) {
    const frame = i * 1000 / 360;
    const raw = 20 + Math.floor(frame / 20) * .02;
    const visual = clock.sample(raw, frame, frame, true);
    assert.ok(Math.abs(visual - (20 + frame / 1000)) < .025);
    if (i) {
      assert.ok(visual >= previousVisual);
      rawError += Math.abs(raw - previousRaw - 1 / 360);
      visualError += Math.abs(visual - previousVisual - 1 / 360);
    }
    previousRaw = raw; previousVisual = visual;
  }
  assert.ok(visualError < rawError * .05);
});

test('uneven callback dispatch does not change the position for a display timestamp', () => {
  const clock = new PlaybackClock();
  for (let i = 0; i < 1000; i++) {
    const frame = i * 1000 / 120, sampledAt = frame + [0, 6, 2, 7][i % 4];
    const visual = clock.sample(8 + sampledAt / 1000, frame, sampledAt, true);
    assert.ok(Math.abs(visual - (8 + frame / 1000)) < 1e-10);
  }
});

test('seeks, pauses, buffering, source changes and resumption use a fresh audio anchor', () => {
  const clock = new PlaybackClock();
  assert.equal(clock.sample(10, 0, 0, true), 10);
  clock.sample(10.01, 10, 10, true);
  clock.reset();
  assert.equal(clock.sample(5, 20, 20, false), 5);
  assert.equal(clock.sample(5, 1000, 1000, false), 5);
  assert.equal(clock.sample(5, 1020, 1020, true), 5);
  assert.equal(clock.sample(5.01, 1030, 1030, true), 5.01);
  clock.reset();
  assert.equal(clock.sample(0, 1040, 1040, false), 0);
  assert.equal(clock.sample(0, 1050, 1050, true), 0);
  assert.equal(clock.sample(20, 20000, 20000, true), 20);
  assert.equal(clock.sample(2, 20010, 20010, true), 2);
});

test('missing media updates cannot advance visual playback indefinitely', () => {
  const clock = new PlaybackClock();
  for (let i = 0; i < 1000; i++) {
    const time = clock.sample(10, i * 5, i * 5, true);
    assert.ok(time >= 10 && time <= 10.04);
  }
  assert.equal(clock.sample(15, 5000, 5000, true), 15);
});

test('large callback delays cannot introduce an unbounded visual offset', () => {
  const clock = new PlaybackClock();
  for (let i = 0; i < 1000; i++) {
    const frame = i * 1000 / 120, sampledAt = frame + 100;
    const media = 10 + sampledAt / 1000;
    const visual = clock.sample(media, frame, sampledAt, true);
    assert.ok(Math.abs(visual - media) <= .04 + 1e-10);
  }
});

test('rate changes, duration bounds and authored strike times remain accurate', () => {
  const clock = new PlaybackClock();
  assert.equal(clock.sample(10, 0, 0, true), 10);
  assert.equal(noteDepth(10, clock.time), 0);
  assert.equal(clock.sample(10.01, 10, 10, true, 2), 10.01);
  assert.ok(Math.abs(clock.sample(10.03, 20, 20, true, 2) - 10.03) < 1e-10);
  assert.equal(clock.sample(11, 1000, 1000, true, 1, 11), 11);
  assert.equal(clock.sample(11, 1010, 1010, true, 1, 11), 11);
});
