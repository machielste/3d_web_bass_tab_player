import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Browser and tests use the same Three.js build; only resolve the vendor URL.
const source = (await fs.readFile(new URL('../static/label-batch.js', import.meta.url), 'utf8'))
  .replace("'/vendor/three.module.js'", JSON.stringify(new URL('../node_modules/three/build/three.module.js', import.meta.url).href));
const { LabelAtlas, LabelBatch, uploadAttribute } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('batched labels retain glyph, world position, size and fade across reuse', () => {
  const drawn = [];
  const context = { strokeText: (...args) => drawn.push(args), fillText: () => {} };
  const atlas = new LabelAtlas(['0', '12', 'B', '0'], { getContext: () => context });
  assert.equal(drawn.length, 3);
  const batch = new LabelBatch(atlas, 128);
  batch.add('12', 12, 1.08, -50, .5, .36, .25);
  batch.add('B', -1, 2.16, .06, .37, .28);
  batch.commit();
  const { geometry } = batch.mesh;
  assert.equal(geometry.instanceCount, 2);
  const attributes = geometry.attributes;
  assert.equal(attributes.labelPosition.getX(0), 12);
  assert.equal(attributes.labelPosition.getZ(0), -50);
  assert.equal(attributes.labelOpacity.getX(0), .25);
  assert.equal(attributes.labelOpacity.getX(1), 1);
  assert.deepEqual([attributes.labelCell.getX(0), attributes.labelCell.getY(0)], atlas.cells.get('12'));
  assert.equal(attributes.labelPosition.updateRanges[0].count, 6);
  const positions = attributes.labelPosition.array;
  batch.reset(); batch.add('0', 3, 0, 0, 4, .09); batch.commit();
  assert.equal(geometry.instanceCount, 1);
  assert.equal(attributes.labelPosition.array, positions);
  assert.equal(attributes.labelPosition.getX(0), 3);
  batch.reset(); batch.commit();
  assert.equal(geometry.instanceCount, 0);
  let textureDisposed = false;
  atlas.texture.addEventListener('dispose', () => { textureDisposed = true; });
  batch.dispose();
  assert.equal(textureDisposed, false);
  atlas.dispose();
  assert.equal(textureDisposed, true);
});

test('GPU upload ranges cover only active instances and reuse their range record', () => {
  const atlas = new LabelAtlas(['0'], { getContext: () => ({ strokeText() {}, fillText() {} }) });
  const batch = new LabelBatch(atlas, 128);
  const attribute = batch.mesh.geometry.attributes.labelPosition;
  uploadAttribute(attribute, 10);
  const range = attribute.updateRanges[0];
  attribute.clearUpdateRanges(); // Three clears ranges after upload.
  uploadAttribute(attribute, 3);
  assert.equal(attribute.updateRanges.length, 1);
  assert.equal(attribute.updateRanges[0], range);
  assert.equal(range.count, 9);
  batch.dispose(); atlas.dispose();
});
