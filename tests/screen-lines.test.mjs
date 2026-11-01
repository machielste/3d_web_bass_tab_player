import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DynamicDrawUsage } from 'three';

const vendor = path => new URL(`../node_modules/three/${path}`, import.meta.url).href;
const source = (await fs.readFile(new URL('../static/screen-lines.js', import.meta.url), 'utf8'))
  .replaceAll("'/vendor/three.module.js'", JSON.stringify(vendor('build/three.module.js')))
  .replace(/'\/vendor\/lines\/([^']+)'/g, (_, file) => JSON.stringify(vendor(`examples/jsm/lines/${file}`)));
const { ScreenLines } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('triangle-based line width survives supersampling, high density, and viewport resize', () => {
  const lines = new ScreenLines([0, 0, 0, 10, 0, -30], { linewidth: 1.25 });
  assert.equal(lines.isMesh, true);
  assert.ok(lines.geometry.index.count > 0);
  // Use the actual addon's viewport update and projection scale: the shader's
  // NDC half-width is linewidth / viewportHeight. Resolve back to CSS pixels.
  for (const [width, height, density, supersampling] of [
    [2560, 1440, 1, 1], [2560, 1440, 1, 1.5], [2560, 1440, 1, 2],
    [1280, 720, 2, 2], [960, 540, 1.25, 1.5], [430, 900, 2, 1]
  ]) {
    lines.onBeforeRender({ getViewport: target => target.set(0, 32, width, height - 32) });
    const viewport = lines.material.resolution;
    const ndcWidth = 2 * lines.material.linewidth / viewport.y;
    const bufferWidth = ndcWidth / 2 * (height - 32) * density * supersampling;
    assert.equal(bufferWidth / (density * supersampling), 1.25);
    assert.equal(viewport.x, width);
  }
  lines.geometry.dispose(); lines.material.dispose();
});

test('moving rails update both endpoints through the original shared buffer', () => {
  const positions = new Float32Array([1, 0, 0, 1, 0, -10, 5, 0, 0, 5, 0, -10]);
  const lines = new ScreenLines(positions, { dynamic: true, color: '#4ab8e5', opacity: .8 });
  const { instanceStart: start, instanceEnd: end } = lines.geometry.attributes;
  const buffer = lines.positionBuffer;
  assert.equal(buffer.array, positions);
  assert.equal(start.data, end.data);
  assert.equal(buffer.usage, DynamicDrawUsage);
  assert.equal(lines.geometry.instanceCount, 2);
  assert.equal(lines.frustumCulled, false);
  positions[0] = 7; positions[3] = 8; positions[11] = -20;
  const previousVersion = buffer.version;
  lines.commit();
  assert.equal(start.getX(0), 7);
  assert.equal(end.getX(0), 8);
  assert.equal(end.getZ(1), -20);
  assert.equal(lines.positionBuffer, buffer);
  assert.equal(buffer.version, previousVersion + 1);
  lines.geometry.dispose(); lines.material.dispose();
});

test('coloured strings retain per-segment colours, opacity and depth settings', () => {
  const lines = new ScreenLines([0, 0, 0, 1, 0, 0], {
    colors: [1, .25, 0, 1, .25, 0], opacity: .72, fog: false, depthWrite: false
  });
  assert.equal(lines.material.vertexColors, true);
  assert.equal(lines.geometry.attributes.instanceColorStart.getY(0), .25);
  assert.equal(lines.material.opacity, .72);
  assert.equal(lines.material.fog, false);
  assert.equal(lines.material.depthWrite, false);
  assert.equal(lines.material.worldUnits, false);
  lines.geometry.dispose(); lines.material.dispose();
});
