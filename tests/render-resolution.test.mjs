import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayWatcher, renderResolution, resolutionMode } from '../static/render-resolution.js';

test('native stays pixel matched at 4K, high density, and fractional browser zoom', () => {
  for (const [width, height, density] of [[3840, 2160, 1], [1920, 1080, 2], [1536, 864, 2.5]]) {
    const result = renderResolution(width, height, density);
    assert.equal(result.ratio, density);
    assert.equal(result.limited, false);
    // Low adaptive quality from an earlier mode cannot blur a fixed mode.
    assert.equal(renderResolution(width, height, density, 'native', .55).ratio, density);
  }
  assert.equal(resolutionMode('obsolete'), 'native');
  assert.equal(resolutionMode('__proto__'), 'native');
  assert.equal(renderResolution(800, 600, NaN).ratio, 1);
});

test('supersampling scales physical width and height, and only Performance uses the adaptive cap', () => {
  const native = renderResolution(1920, 1080, 2).ratio;
  assert.equal(renderResolution(1920, 1080, 2, '1.5x', .55).ratio, native * 1.5);
  assert.equal(renderResolution(1920, 1080, 2, '2x', .55).ratio, native * 2);
  const performance = renderResolution(3840, 2160, 2, 'performance');
  assert.ok(3840 * 2160 * performance.ratio ** 2 <= 2_000_000 + 1e-8);
  assert.equal(renderResolution(3840, 2160, 2, 'performance', .55).ratio, performance.ratio * .55);
});

test('GPU dimension limits preserve aspect ratio and report a limited supersampling request', () => {
  const result = renderResolution(3840, 2160, 2, '2x', 1, { width: 8192, height: 8192 });
  assert.equal(result.requestedRatio, 4);
  assert.equal(result.ratio, 8192 / 3840);
  assert.equal(result.limited, true);
  const portrait = renderResolution(2160, 3840, 2, '2x', 1, { width: 8192, height: 4096 });
  assert.equal(portrait.ratio, 4096 / 3840);
  assert.equal(portrait.limited, true);
});

function displayHarness() {
  const view = new EventTarget(), queries = [];
  view.document = new EventTarget();
  view.devicePixelRatio = 1;
  view.matchMedia = media => {
    const query = new EventTarget(); query.media = media; queries.push(query); return query;
  };
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  }
  const container = {}, changes = [];
  const watcher = new DisplayWatcher(container, () => changes.push(view.devicePixelRatio), view, Observer);
  return { view, queries, container, changes, watcher };
}

test('a paused display is invalidated on repeated density changes without a CSS resize', () => {
  const { view, queries, changes, watcher } = displayHarness();
  assert.equal(queries[0].media, '(resolution: 1dppx)');
  view.devicePixelRatio = 2;
  queries[0].dispatchEvent(new Event('change'));
  assert.deepEqual(changes, [2]);
  assert.equal(queries[1].media, '(resolution: 2dppx)');
  view.devicePixelRatio = 1.25;
  queries[1].dispatchEvent(new Event('change'));
  assert.deepEqual(changes, [2, 1.25]);
  assert.equal(queries[2].media, '(resolution: 1.25dppx)');
  queries[0].dispatchEvent(new Event('change'));
  assert.equal(changes.length, 2); // Old density listeners are detached.
  watcher.disconnect();
});

test('layout, window resize, focus and visibility changes refresh the display; teardown detaches listeners', () => {
  const { view, queries, container, changes, watcher } = displayHarness();
  assert.equal(watcher.observer.target, container);
  watcher.observer.callback([]);
  view.dispatchEvent(new Event('resize'));
  view.dispatchEvent(new Event('focus'));
  view.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(changes.length, 4);
  watcher.disconnect();
  assert.equal(watcher.observer.target, null);
  view.dispatchEvent(new Event('resize'));
  view.dispatchEvent(new Event('focus'));
  view.document.dispatchEvent(new Event('visibilitychange'));
  queries.at(-1).dispatchEvent(new Event('change'));
  assert.equal(changes.length, 4);
});
