// Instanced rounded rectangles (fill or stroke) in one draw call: node plates,
// feedback strips, ticks, rules, outlines and badges.

import * as THREE from 'three';
import { InstanceBuffer } from './glyphs';

const VERT = /* glsl */ `
attribute vec4 iRect;
attribute vec4 iColor;
attribute vec2 iStyle;
varying vec2 vLocal;
varying vec2 vHalf;
varying vec4 vColor;
varying vec2 vStyle;
void main() {
  vec2 p = iRect.xy + position.xy * iRect.zw;
  vHalf = iRect.zw * 0.5;
  vLocal = (position.xy - 0.5) * iRect.zw;
  vColor = iColor;
  vStyle = iStyle;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float opacity;
varying vec2 vLocal;
varying vec2 vHalf;
varying vec4 vColor;
varying vec2 vStyle;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float r = min(vStyle.x, min(vHalf.x, vHalf.y));
  float d = sdRoundBox(vLocal, vHalf, r);
  float fw = max(fwidth(d), 1e-5);
  float a;
  if (vStyle.y > 0.0) {
    a = clamp(0.5 - (abs(d + vStyle.y * 0.5) - vStyle.y * 0.5) / fw, 0.0, 1.0);
  } else {
    a = clamp(0.5 - d / fw, 0.0, 1.0);
  }
  a *= vColor.a * opacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

export class QuadBatch {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private buf: InstanceBuffer;

  constructor(capacity = 512) {
    this.buf = new InstanceBuffer(['iRect', 'iColor', 'iStyle'], [4, 4, 2], capacity);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { opacity: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.buf.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.buf.onGeometry = (g) => (this.mesh.geometry = g);
  }

  clear(): void {
    this.buf.count = 0;
  }

  get count(): number {
    return this.buf.count;
  }

  /** A rectangle centred at (cx, cy) of size w × h (world units); `stroke` > 0 draws only the outline. */
  add(cx: number, cy: number, w: number, h: number, r: number, g: number, b: number, a: number, radius = 0, stroke = 0): void {
    if (a <= 0.003 || w <= 0 || h <= 0) return;
    const i = this.buf.next();
    const [R, C, S] = this.buf.arrays;
    const o = i * 4;
    R[o] = cx - w / 2;
    R[o + 1] = cy - h / 2;
    R[o + 2] = w;
    R[o + 3] = h;
    C[o] = r;
    C[o + 1] = g;
    C[o + 2] = b;
    C[o + 3] = a;
    S[i * 2] = radius;
    S[i * 2 + 1] = stroke;
  }

  commit(): void {
    this.buf.commit();
  }

  dispose(): void {
    this.buf.dispose();
    this.material.dispose();
  }
}
