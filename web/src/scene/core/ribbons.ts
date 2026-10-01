// Ribbons (the tree's rivers): every ribbon of a tree batched into one
// indexed triangle buffer. The builder is plain TypeScript (tested); the mesh
// uploads it.

import * as THREE from 'three';

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Growable vertex/index arrays for ribbons: position (x, y, 0), colour (r, g, b, a). */
export class RibbonBuilder {
  pos: Float32Array;
  col: Float32Array;
  idx: Uint32Array;
  nv = 0;
  ni = 0;
  /** Bumped when the arrays are replaced (the mesh re-creates its attributes). */
  generation = 0;

  constructor(vertices = 4096) {
    this.pos = new Float32Array(vertices * 3);
    this.col = new Float32Array(vertices * 4);
    this.idx = new Uint32Array(vertices * 3);
  }

  clear(): void {
    this.nv = 0;
    this.ni = 0;
  }

  private reserve(nv: number, ni: number): void {
    if (this.nv + nv > this.pos.length / 3) {
      let cap = this.pos.length / 3;
      while (cap < this.nv + nv) cap *= 2;
      const p = new Float32Array(cap * 3);
      p.set(this.pos.subarray(0, this.nv * 3));
      const c = new Float32Array(cap * 4);
      c.set(this.col.subarray(0, this.nv * 4));
      this.pos = p;
      this.col = c;
      this.generation++;
    }
    if (this.ni + ni > this.idx.length) {
      let cap = this.idx.length;
      while (cap < this.ni + ni) cap *= 2;
      const x = new Uint32Array(cap);
      x.set(this.idx.subarray(0, this.ni));
      this.idx = x;
      this.generation++;
    }
  }

  private vertex(x: number, y: number, r: number, g: number, b: number, a: number): number {
    const i = this.nv++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = 0;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
    return i;
  }

  /**
   * A ribbon from (x0, y0) to (x1, y1) whose horizontal width goes from w0 to
   * w1, leaving and arriving vertically (a smoothstep in x over y). Only the
   * part t ∈ [0, until] is drawn (draw-on animation). Returns the number of
   * segments drawn.
   */
  ribbon(x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, r: number, g: number, b: number, a: number, until = 1, segments?: number): number {
    if (a <= 0.003 || until <= 0) return 0;
    const u = Math.min(1, until);
    const curved = Math.abs(x1 - x0) > 0.01;
    const n = Math.max(1, Math.ceil((segments ?? (curved ? 16 : 1)) * u));
    this.reserve((n + 1) * 2, n * 6);
    let prevL = -1;
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * u;
      const s = curved ? smooth(t) : t;
      const cx = x0 + (x1 - x0) * s;
      const cy = y0 + (y1 - y0) * t;
      const w = (w0 + (w1 - w0) * t) / 2;
      const l = this.vertex(cx - w, cy, r, g, b, a);
      this.vertex(cx + w, cy, r, g, b, a);
      if (prevL >= 0) {
        const i = this.ni;
        this.idx[i] = prevL;
        this.idx[i + 1] = prevL + 1;
        this.idx[i + 2] = l;
        this.idx[i + 3] = prevL + 1;
        this.idx[i + 4] = l + 1;
        this.idx[i + 5] = l;
        this.ni += 6;
      }
      prevL = l;
    }
    return n;
  }

  /** An axis-free straight band of the given width between two points. */
  segment(x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0.003 || width <= 0) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len <= 0) return;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    this.reserve(4, 6);
    const v = this.vertex(x0 + nx, y0 + ny, r, g, b, a);
    this.vertex(x0 - nx, y0 - ny, r, g, b, a);
    this.vertex(x1 + nx, y1 + ny, r, g, b, a);
    this.vertex(x1 - nx, y1 - ny, r, g, b, a);
    const i = this.ni;
    this.idx[i] = v;
    this.idx[i + 1] = v + 1;
    this.idx[i + 2] = v + 2;
    this.idx[i + 3] = v + 1;
    this.idx[i + 4] = v + 3;
    this.idx[i + 5] = v + 2;
    this.ni += 6;
  }

  /** A dashed straight line (dash and gap lengths in world units). */
  dashed(x0: number, y0: number, x1: number, y1: number, width: number, dash: number, gap: number, r: number, g: number, b: number, a: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len <= 0 || dash <= 0) return;
    const step = dash + gap;
    for (let s = 0; s < len; s += step) {
      const e = Math.min(len, s + dash);
      this.segment(x0 + ((x1 - x0) * s) / len, y0 + ((y1 - y0) * s) / len, x0 + ((x1 - x0) * e) / len, y0 + ((y1 - y0) * e) / len, width, r, g, b, a);
    }
  }
}

/** Centre x of a ribbon at height y (for hit testing), or null when y is outside it. */
export function ribbonXAt(x0: number, y0: number, x1: number, y1: number, y: number): number | null {
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  if (y < lo || y > hi || y0 === y1) return null;
  const t = (y - y0) / (y1 - y0);
  return x0 + (x1 - x0) * smooth(t);
}

const VERT = /* glsl */ `
attribute vec4 rgba;
varying vec4 vColor;
void main() {
  vColor = rgba;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float opacity;
varying vec4 vColor;
void main() {
  float a = vColor.a * opacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/** The mesh that draws a RibbonBuilder's buffers. */
export class RibbonMesh {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;
  private generation = -1;
  private posAttr: THREE.BufferAttribute | null = null;
  private colAttr: THREE.BufferAttribute | null = null;
  private idxAttr: THREE.BufferAttribute | null = null;

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { opacity: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  upload(b: RibbonBuilder): void {
    if (b.generation !== this.generation || !this.posAttr) {
      const old = this.geometry;
      this.geometry = new THREE.BufferGeometry();
      this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
      this.posAttr = new THREE.BufferAttribute(b.pos, 3).setUsage(THREE.DynamicDrawUsage);
      this.colAttr = new THREE.BufferAttribute(b.col, 4).setUsage(THREE.DynamicDrawUsage);
      this.idxAttr = new THREE.BufferAttribute(b.idx, 1).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position', this.posAttr);
      this.geometry.setAttribute('rgba', this.colAttr);
      this.geometry.setIndex(this.idxAttr);
      this.mesh.geometry = this.geometry;
      old.dispose();
      this.generation = b.generation;
    }
    const p = this.posAttr!;
    const c = this.colAttr!;
    const x = this.idxAttr!;
    p.clearUpdateRanges();
    p.addUpdateRange(0, b.nv * 3);
    p.needsUpdate = true;
    c.clearUpdateRanges();
    c.addUpdateRange(0, b.nv * 4);
    c.needsUpdate = true;
    x.clearUpdateRanges();
    x.addUpdateRange(0, b.ni);
    x.needsUpdate = true;
    this.geometry.setDrawRange(0, b.ni);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
