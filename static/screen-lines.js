import { DynamicDrawUsage } from '/vendor/three.module.js';
import { LineSegments2 } from '/vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '/vendor/lines/LineSegmentsGeometry.js';
import { LineMaterial } from '/vendor/lines/LineMaterial.js';

// Each segment is an instanced triangle strip, anchored in world space and
// expanded by the vertex shader to a width in CSS pixels. LineSegments2 updates
// the viewport uniform before drawing, so supersampling and display density
// increase the sample count without shrinking the apparent line width.
export class ScreenLines extends LineSegments2 {
  constructor(positions, { colors, dynamic = false, linewidth = 1.25, ...options } = {}) {
    const geometry = new LineSegmentsGeometry().setPositions(positions);
    if (colors) geometry.setColors(colors);
    const material = new LineMaterial({
      transparent: true, ...options, linewidth, worldUnits: false,
      vertexColors: Boolean(colors)
    });
    super(geometry, material);
    // Screen-space expansion and moving rails extend beyond world-space bounds.
    this.frustumCulled = false;
    this.positionBuffer = geometry.attributes.instanceStart.data;
    if (dynamic) this.positionBuffer.setUsage(DynamicDrawUsage);
  }

  commit() {
    // setPositions retains a Float32Array. Update it in place during playback
    // rather than allocating new interleaved buffers for the moving rails.
    this.positionBuffer.needsUpdate = true;
  }
}
