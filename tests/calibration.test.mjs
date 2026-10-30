import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { HIGHWAY_REFERENCE } from '../static/timeline.js';

test('the runtime camera projects the measured four-fret road onto the reference rails', () => {
  const fit = JSON.parse(fs.readFileSync(new URL('../docs/highway-reference.json', import.meta.url)));
  const [width, height] = fit.reference_size;
  const camera = new THREE.PerspectiveCamera(HIGHWAY_REFERENCE.fov, width / height, .1, 300);
  new THREE.Matrix4().fromArray(HIGHWAY_REFERENCE.matrix).decompose(camera.position, camera.quaternion, camera.scale);
  camera.updateMatrixWorld();
  const corners = [[0,0,0], [4,0,0], [0,0,-HIGHWAY_REFERENCE.depth], [4,0,-HIGHWAY_REFERENCE.depth]];
  for (let i = 0; i < corners.length; i++) {
    const p = new THREE.Vector3(...corners[i]).project(camera);
    const pixel = [(p.x + 1) * width / 2, (1 - p.y) * height / 2];
    assert.ok(Math.hypot(pixel[0] - fit.reference_corners[i][0], pixel[1] - fit.reference_corners[i][1]) < .05);
  }
});
