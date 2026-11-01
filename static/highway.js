import * as THREE from '/vendor/three.module.js';
import { HIGHWAY_REFERENCE, CameraFollow, HandPositionTrack, NoteIndex, firstBeatAt, highwayTiming, noteDepth, noteOpacity, noteWorldX, stringLaneY } from './timeline.js';
import { LabelAtlas, LabelBatch, uploadAttribute } from './label-batch.js';
import { RenderQuality } from './render-loop.js';
import { DisplayWatcher, renderResolution, resolutionMode } from './render-resolution.js';
import { ScreenLines } from './screen-lines.js';
const ROAD_SEGMENTS = 96;
const COLORS = ['#f87989', '#f4ca6a', '#66b7f1', '#ed9b61'];
const FIVE_COLORS = ['#b297ed', ...COLORS];

function fadingMaterial(timing, options = {}) {
  const material = new THREE.MeshBasicMaterial({ transparent: true, fog: false, alphaTest: .002, ...options });
  material.onBeforeCompile = shader => {
    shader.uniforms.fadeStart = { value: timing.fadeStartDepth };
    shader.uniforms.fadeEnd = { value: timing.spawnDepth };
    shader.vertexShader = 'varying float vNoteDepth;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvNoteDepth = -(modelMatrix * instanceMatrix * vec4(transformed, 1.0)).z;');
    shader.fragmentShader = 'uniform float fadeStart; uniform float fadeEnd; varying float vNoteDepth;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\ndiffuseColor.a *= 1.0 - smoothstep(fadeStart, fadeEnd, vNoteDepth);');
  };
  material.customProgramCacheKey = () => 'note-depth-alpha-v2';
  return material;
}

export class Highway {
  constructor(container, invalidate = () => {}) {
    this.container = container;
    this.invalidate = invalidate;
    this.quality = new RenderQuality();
    this.resolutionMode = 'native';
    this.resizePending = true;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    const gl = this.renderer.getContext(), viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const maxBuffer = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), this.renderer.capabilities.maxTextureSize);
    this.resolutionLimits = { width: Math.min(maxBuffer, viewport[0]), height: Math.min(maxBuffer, viewport[1]) };
    this.renderer.setClearColor(0x0b1018, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Perspective bass tablature: lowest string at the top; notes fade in beyond a finite four-fret highway.');
    this.renderer.domElement.setAttribute('role', 'img');
    container.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b1018, 60, 85);
    this.camera = new THREE.PerspectiveCamera(HIGHWAY_REFERENCE.fov, 1, .1, 300);
    const reference = new THREE.Matrix4().fromArray(HIGHWAY_REFERENCE.matrix);
    reference.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
    this.referencePosition = this.camera.position.clone();
    this.board = new THREE.Group();
    this.road = new THREE.Group();
    this.scene.add(this.board, this.road);
    this.visibleNotes = [];
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.matrix = new THREE.Matrix4();
    this.rotation = new THREE.Quaternion();
    this.position = new THREE.Vector3();
    this.scale = new THREE.Vector3();
    this.color = new THREE.Color();
    this.projected = new THREE.Vector3();
    this.setSong({ notes: [], beats: [], strings: ['E', 'A', 'D', 'G'] });
    this.displayWatcher = new DisplayWatcher(container, () => this.resize());
    this.resize();
  }

  clearGroup(group) {
    group.traverse(item => {
      if (item.geometry) item.geometry.dispose();
      if (item.isLineSegments || item.isMesh) item.material.dispose();
    });
    group.clear();
  }

  setSong(chart) {
    this.boardLabels?.dispose();
    this.atlas?.dispose();
    this.clearGroup(this.board); this.clearGroup(this.road);
    this.chart = chart;
    this.index = new NoteIndex(chart.notes);
    this.timing = highwayTiming(chart.beats);
    this.handTrack = new HandPositionTrack(chart.notes);
    this.cameraFollow = new CameraFollow();
    this.lastTime = null;
    this.colors = chart.strings.length === 5 ? FIVE_COLORS : COLORS;
    this.maxFret = Math.max(24, chart.notes.reduce((maximum, n) => Math.max(maximum, n.fret), 0));
    this.fretText = Array.from({ length: this.maxFret + 1 }, (_, fret) => String(fret));
    this.atlas = new LabelAtlas([...this.fretText, ...chart.strings]);
    this.boardLabels = new LabelBatch(this.atlas, this.maxFret + 1 + chart.strings.length);
    this.board.add(this.boardLabels.mesh);
    const top = stringLaneY(0, chart.strings.length);
    const vertices = [], colors = [];
    const line = (a, b, color) => {
      vertices.push(...a, ...b);
      const c = new THREE.Color(color); colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    chart.strings.forEach((name, i) => {
      const y = stringLaneY(i, chart.strings.length);
      line([-5, y, 0], [this.maxFret + 5, y, 0], this.colors[i]);
    });
    for (let fret = 0; fret <= this.maxFret; fret++) {
      line([fret - .5, -.08, 0], [fret - .5, top + .12, 0], '#324553');
    }
    this.board.add(new ScreenLines(vertices, { colors, linewidth: 1.25, opacity: .72, fog: false }));
    // Absolute fret lanes continue faintly on both sides of the hand corridor.
    // These do not move with the blue guide and give lateral camera travel a
    // visible, numbered neck to move along.
    const context = [];
    for (let fret = 0; fret <= this.maxFret + 1; fret++) {
      const x = fret - .5;
      context.push(x, .003, 0, x, .003, -this.timing.depth);
    }
    for (let step = 0; step <= 6; step++) {
      const z = -this.timing.depth * step / 6;
      context.push(-.5, .003, z, this.maxFret + .5, .003, z);
    }
    const contextLines = new ScreenLines(context,
      { linewidth: 1, color: '#4d7891', opacity: .28, depthWrite: false });
    contextLines.renderOrder = 1;
    this.board.add(contextLines);
    const floorGeometry = new THREE.BufferGeometry();
    this.floorPositions = new Float32Array((ROAD_SEGMENTS + 1) * 6);
    this.floorAttribute = new THREE.BufferAttribute(this.floorPositions, 3).setUsage(THREE.DynamicDrawUsage);
    floorGeometry.setAttribute('position', this.floorAttribute);
    const triangles = [];
    for (let i = 0; i < ROAD_SEGMENTS; i++) {
      const a = i * 2;
      triangles.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    floorGeometry.setIndex(triangles);
    const floor = new THREE.Mesh(
      floorGeometry,
      new THREE.MeshBasicMaterial({ color: '#145487', transparent: true, opacity: .48, depthWrite: false })
    );
    floor.frustumCulled = false;
    this.road.add(floor);
    this.railPositions = new Float32Array(2 * ROAD_SEGMENTS * 6);
    this.rails = new ScreenLines(this.railPositions,
      { dynamic: true, linewidth: 1.5, color: '#4ab8e5', opacity: .8 });
    this.road.add(this.rails);
    // Allocate the peak visible window once, so dense passages never grow GPU
    // buffers or create materials in the animation callback.
    this.setCapacity(Math.max(128, 2 ** Math.ceil(Math.log2(this.index.maximumVisible(this.timing.spawnSeconds) || 1))));
    this.quality.reset();
    this.resize();
  }

  setCapacity(capacity) {
    for (const mesh of [this.heads, this.tails, this.beatMesh]) {
      if (mesh) {
        this.scene.remove(mesh); mesh.dispose(); mesh.material.dispose();
        if (mesh.geometry !== this.box) mesh.geometry.dispose();
      }
    }
    this.noteLabels?.dispose();
    this.capacity = capacity;
    this.heads = new THREE.InstancedMesh(this.box, fadingMaterial(this.timing), capacity);
    this.tails = new THREE.InstancedMesh(this.box, fadingMaterial(this.timing, { opacity: .42, depthWrite: false }), capacity);
    this.beatMesh = new THREE.InstancedMesh(this.box, new THREE.MeshBasicMaterial({ transparent: true, opacity: .4, depthWrite: false }), 256);
    this.noteLabels = new LabelBatch(this.atlas, capacity);
    this.noteLabels.mesh.renderOrder = 3;
    this.scene.add(this.noteLabels.mesh);
    this.tails.renderOrder = 1; this.heads.renderOrder = 2;
    for (const mesh of [this.heads, this.tails, this.beatMesh]) {
      mesh.count = 0; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.color.set('#ffffff'));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(mesh);
    }
  }

  setResolution(mode) {
    this.resolutionMode = resolutionMode(mode);
    this.quality.scale = 1;
    this.resize();
  }

  resize() {
    this.resizePending = true;
    this.quality.reset();
    this.invalidate();
  }

  applyResize() {
    const deviceRatio = globalThis.devicePixelRatio || 1;
    if (!this.resizePending && this.deviceRatio === deviceRatio) return;
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!width || !height) return;
    this.resizePending = false;
    this.deviceRatio = deviceRatio;
    this.resolution = renderResolution(width, height, deviceRatio, this.resolutionMode, this.quality.scale, this.resolutionLimits);
    const { ratio } = this.resolution;
    if (width === this.width && height === this.height && ratio === this.renderer.getPixelRatio()) return;
    this.width = width; this.height = height;
    this.renderer.setDrawingBufferSize(width, height, ratio);
    this.renderer.setViewport(0, 32, width, Math.max(1, height - 32));
    this.camera.aspect = width / Math.max(1, height - 32);
    this.camera.updateProjectionMatrix();
  }

  instance(mesh, index, x, y, z, width, height, depth, color) {
    this.position.set(x, y, z); this.scale.set(width, height, depth);
    this.matrix.compose(this.position, this.rotation, this.scale);
    mesh.setMatrixAt(index, this.matrix);
    this.color.set(color); mesh.setColorAt(index, this.color);
  }

  updateRoad(time) {
    const { depth, spacing } = this.timing;
    for (let i = 0; i <= ROAD_SEGMENTS; i++) {
      const distance = depth * i / ROAD_SEGMENTS;
      const start = this.handTrack.startAt(time + distance / spacing);
      const offset = i * 6;
      this.floorPositions[offset] = start;
      this.floorPositions[offset + 1] = -.015;
      this.floorPositions[offset + 2] = -distance;
      this.floorPositions[offset + 3] = start + 4;
      this.floorPositions[offset + 4] = -.015;
      this.floorPositions[offset + 5] = -distance;
    }
    // Only the highlight's outer edges change lanes. The actual fret rails
    // above remain straight in world space, including inside the blue surface.
    for (let rail = 0; rail < 2; rail++) {
      for (let i = 0; i < ROAD_SEGMENTS; i++) {
        const offset = (rail * ROAD_SEGMENTS + i) * 6;
        this.railPositions[offset] = this.floorPositions[i * 6] + rail * 4;
        this.railPositions[offset + 1] = 0;
        this.railPositions[offset + 2] = this.floorPositions[i * 6 + 2];
        this.railPositions[offset + 3] = this.floorPositions[(i + 1) * 6] + rail * 4;
        this.railPositions[offset + 4] = 0;
        this.railPositions[offset + 5] = this.floorPositions[(i + 1) * 6 + 2];
      }
    }
    this.floorAttribute.needsUpdate = true;
    this.rails.commit();
  }

  render(time, frameTime = null) {
    if (frameTime === null || this.resolutionMode !== 'performance') this.quality.reset();
    else if (this.quality.sample(frameTime)) this.resizePending = true;
    this.applyResize();
    this.lastTime = time;
    const { spawnSeconds, spacing, depth } = this.timing;
    const visible = this.index.visible(time, spawnSeconds, this.visibleNotes);
    const cameraStart = this.cameraFollow.update(time, this.handTrack.startAt(time + .18));
    this.camera.position.copy(this.referencePosition); this.camera.position.x += cameraStart;
    this.camera.updateMatrixWorld();
    this.updateRoad(time);
    this.scene.fog.near = -this.projected.set(cameraStart + 2, 0, -depth * .76).applyMatrix4(this.camera.matrixWorldInverse).z;
    this.scene.fog.far = -this.projected.set(cameraStart + 2, 0, -depth).applyMatrix4(this.camera.matrixWorldInverse).z;
    this.boardLabels.reset(); this.noteLabels.reset();
    for (let i = 0; i < this.chart.strings.length; i++) {
      this.boardLabels.add(this.chart.strings[i], cameraStart - 2.5, stringLaneY(i, this.chart.strings.length), .06, .37, .28);
    }
    for (let fret = Math.max(0, Math.ceil(cameraStart - 4)); fret <= Math.min(this.maxFret, cameraStart + 8); fret++) {
      const projected = this.projected.set(fret, -.13, .06).project(this.camera);
      if (Math.abs(fret - cameraStart - 2) < 6 && Math.abs(projected.x) < .98 && projected.y > -.98) {
        this.boardLabels.add(this.fretText[fret], fret, -.13, .06, .43, .28);
      }
    }
    let headCount = 0, tailCount = 0;
    for (let i = visible.length - 1; i >= 0; i--) {
      const note = visible[i];
      const z = noteDepth(Math.max(time, note.time), time, spacing);
      const tailZ = noteDepth(Math.min(time + spawnSeconds, note.end), time, spacing);
      const open = note.fret === 0;
      const x = noteWorldX(note, this.handTrack);
      const y = stringLaneY(note.string, this.chart.strings.length);
      const color = this.colors[note.string], alpha = noteOpacity(-z, depth);
      const active = note.time <= time && note.end >= time;
      this.instance(this.heads, headCount, x, y, z, open ? 4 : .44, open ? .09 : active ? .29 : .24, .12, active ? '#e9fff6' : color);
      if (alpha > .002) this.noteLabels.add(this.fretText[note.fret], x, y, z + .13, .5, .36, alpha);
      if (note.end - Math.max(time, note.time) > .09) {
        this.instance(this.tails, tailCount++, x, y, (z + tailZ) / 2, open ? 3.9 : .12, .045,
          Math.max(.01, z - tailZ), color);
      }
      headCount++;
    }
    this.boardLabels.commit(); this.noteLabels.commit();
    this.heads.count = headCount; this.tails.count = tailCount;
    let beatCount = 0;
    for (let i = firstBeatAt(this.chart.beats, time); i < this.chart.beats.length; i++) {
      const beat = this.chart.beats[i];
      if (beat.time > time + this.timing.previewSeconds || beatCount >= 256) break;
      this.instance(this.beatMesh, beatCount++, this.handTrack.startAt(beat.time) + 2, -.005, noteDepth(beat.time, time, spacing), 4, .015,
        beat.bar ? .08 : .025, beat.bar ? '#6d9cad' : '#335a70');
    }
    this.beatMesh.count = beatCount;
    for (const mesh of [this.heads, this.tails, this.beatMesh]) {
      uploadAttribute(mesh.instanceMatrix, mesh.count);
      uploadAttribute(mesh.instanceColor, mesh.count);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
