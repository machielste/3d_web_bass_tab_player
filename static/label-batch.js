import * as THREE from '/vendor/three.module.js';

// All glyphs are uploaded before playback. Billboard instances share one texture
// and one draw call, rather than allocating a sprite/material for every note.
export class LabelAtlas {
  constructor(texts, canvas = document.createElement('canvas')) {
    const unique = [...new Set(texts)];
    this.columns = Math.min(8, unique.length);
    this.rows = Math.ceil(unique.length / this.columns);
    canvas.width = this.columns * 128; canvas.height = this.rows * 96;
    const context = canvas.getContext('2d');
    context.font = '600 58px "Segoe UI", sans-serif';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    context.lineWidth = 7; context.strokeStyle = '#15212a'; context.fillStyle = '#f4f9fc';
    this.cells = new Map();
    unique.forEach((text, index) => {
      const column = index % this.columns, row = Math.floor(index / this.columns);
      context.strokeText(text, column * 128 + 64, row * 96 + 49);
      context.fillText(text, column * 128 + 64, row * 96 + 49);
      this.cells.set(text, [column, this.rows - row - 1]);
    });
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
  }

  dispose() { this.texture.dispose(); }
}

// Reuse the range record too: Three clears updateRanges after each upload.
export function uploadAttribute(attribute, count) {
  if (!count) return;
  attribute.clearUpdateRanges();
  attribute.uploadRange ??= { start: 0, count: 0 };
  attribute.uploadRange.count = count * attribute.itemSize;
  attribute.updateRanges.push(attribute.uploadRange);
  attribute.needsUpdate = true;
}

export class LabelBatch {
  constructor(atlas, capacity) {
    this.atlas = atlas;
    this.count = 0;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    for (const [name, size] of [['labelPosition', 3], ['labelSize', 2], ['labelCell', 2], ['labelOpacity', 1]]) {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage));
    }
    geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { atlas: { value: atlas.texture }, atlasGrid: { value: new THREE.Vector2(atlas.columns, atlas.rows) } },
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute vec3 labelPosition;
        attribute vec2 labelSize;
        attribute vec2 labelCell;
        attribute float labelOpacity;
        uniform vec2 atlasGrid;
        varying vec2 vLabelUv;
        varying float vLabelOpacity;
        void main() {
          vLabelUv = (uv + labelCell) / atlasGrid;
          vLabelOpacity = labelOpacity;
          vec4 center = modelViewMatrix * vec4(labelPosition, 1.0);
          center.xy += position.xy * labelSize;
          gl_Position = projectionMatrix * center;
        }`,
      fragmentShader: `
        uniform sampler2D atlas;
        varying vec2 vLabelUv;
        varying float vLabelOpacity;
        void main() {
          gl_FragColor = texture2D(atlas, vLabelUv);
          gl_FragColor.a *= vLabelOpacity;
          if (gl_FragColor.a < .002) discard;
          #include <colorspace_fragment>
        }`
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  reset() { this.count = 0; }

  add(text, x, y, z, width, height, opacity = 1) {
    const attributes = this.mesh.geometry.attributes;
    const index = this.count++;
    const cell = this.atlas.cells.get(text);
    attributes.labelPosition.setXYZ(index, x, y, z);
    attributes.labelSize.setXY(index, width, height);
    attributes.labelCell.setXY(index, cell[0], cell[1]);
    attributes.labelOpacity.setX(index, opacity);
  }

  commit() {
    this.mesh.geometry.instanceCount = this.count;
    for (const name of ['labelPosition', 'labelSize', 'labelCell', 'labelOpacity']) uploadAttribute(this.mesh.geometry.attributes[name], this.count);
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
