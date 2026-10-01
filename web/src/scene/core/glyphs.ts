// Instanced text: one glyph atlas (canvas 2D, monospace) and a batch that
// draws every glyph of many labels as instanced quads in one draw call.
//
// The specification names troika-three-text for word labels; troika needs a
// font file fetched at run time (its default comes from a CDN, which the
// COOP/COEP headers block), so the tree uses this atlas of the app's bundled
// monospace (Martian Mono, loaded before the scene starts) instead: one draw
// call for all labels, and no network or worker dependency.

import * as THREE from 'three';

const FONT_PX = 48;
const PAD = 5;
const EXTRA = '…·✓✗→−×▸●○';
const MONO = "'Martian Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";

export interface GlyphMetrics {
  /** Advance width per em. */
  advance: number;
  /** Cell width and height per em (the quad drawn for a glyph). */
  cellW: number;
  cellH: number;
  /** Distance from the cell's bottom to the cap-height centre, per em. */
  capMid: number;
}

export class GlyphAtlas {
  texture: THREE.Texture;
  metrics: GlyphMetrics;
  private uvs = new Map<string, [number, number, number, number]>();
  private fallback: [number, number, number, number] = [0, 0, 0, 0];

  constructor() {
    const chars: string[] = [];
    for (let c = 32; c < 127; c++) chars.push(String.fromCharCode(c));
    for (const ch of EXTRA) chars.push(ch);
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const g = canvas?.getContext('2d') ?? null;
    let adv = FONT_PX * 0.6;
    const font = `600 ${FONT_PX}px ${MONO}`;
    // Martian Mono has a width axis; semi-condensed keeps five-letter words compact.
    const narrow = (ctx: CanvasRenderingContext2D) => {
      if ('fontStretch' in ctx) (ctx as CanvasRenderingContext2D & { fontStretch: string }).fontStretch = 'semi-condensed';
    };
    if (g) {
      g.font = font;
      narrow(g);
      adv = g.measureText('M').width || adv;
    }
    const cw = Math.ceil(adv) + PAD * 2;
    const ch = Math.ceil(FONT_PX * 1.3) + PAD * 2;
    const cols = Math.floor(1024 / cw);
    const rows = Math.ceil(chars.length / cols);
    const W = 1024;
    let H = 64;
    while (H < rows * ch) H *= 2;
    const baseline = PAD + Math.round(FONT_PX * 1.0);
    // Cap height of a typical monospace font is about 0.7 em.
    const capMidFromTop = baseline - FONT_PX * 0.36;
    this.metrics = { advance: adv / FONT_PX, cellW: cw / FONT_PX, cellH: ch / FONT_PX, capMid: (ch - capMidFromTop) / FONT_PX };
    if (canvas && g) {
      canvas.width = W;
      canvas.height = H;
      g.font = font;
      narrow(g);
      g.fillStyle = '#ffffff';
      g.textBaseline = 'alphabetic';
      g.textAlign = 'center';
      chars.forEach((c, i) => {
        const x = (i % cols) * cw;
        const y = Math.floor(i / cols) * ch;
        const w = g.measureText(c).width;
        g.save();
        g.translate(x + cw / 2, y + baseline);
        if (w > cw - 2) g.scale((cw - 2) / w, (cw - 2) / w);
        g.fillText(c, 0, 0);
        g.restore();
        // Texture v runs bottom-up (flipY).
        this.uvs.set(c, [x / W, 1 - (y + ch) / H, (x + cw) / W, 1 - y / H]);
      });
      const tex = new THREE.CanvasTexture(canvas);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 4;
      this.texture = tex;
    } else {
      this.texture = new THREE.Texture();
    }
    this.fallback = this.uvs.get('?') ?? this.fallback;
  }

  uv(ch: string): [number, number, number, number] {
    return this.uvs.get(ch) ?? this.fallback;
  }

  /** Width of a string at em size `size`. */
  width(text: string, size: number): number {
    return [...text].length * this.metrics.advance * size;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

let shared: GlyphAtlas | null = null;
export function glyphAtlas(): GlyphAtlas {
  if (!shared) shared = new GlyphAtlas();
  return shared;
}

const QUAD_POS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
const QUAD_IDX = [0, 1, 2, 0, 2, 3];

/** A growable set of float instance attributes on an instanced quad. */
export class InstanceBuffer {
  geometry: THREE.InstancedBufferGeometry;
  count = 0;
  capacity: number;
  arrays: Float32Array[];
  private attrs: THREE.InstancedBufferAttribute[] = [];

  constructor(
    private names: string[],
    private sizes: number[],
    capacity = 256,
  ) {
    this.capacity = capacity;
    this.arrays = sizes.map((s) => new Float32Array(capacity * s));
    this.geometry = this.makeGeometry();
  }

  private makeGeometry(): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(QUAD_POS, 3));
    g.setIndex(QUAD_IDX);
    this.attrs = this.names.map((n, i) => {
      const a = new THREE.InstancedBufferAttribute(this.arrays[i], this.sizes[i]);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(n, a);
      return a;
    });
    g.instanceCount = 0;
    // Instances spread over the whole plane; skip culling.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    return g;
  }

  /** Make room for one more instance; returns its index. */
  next(): number {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    return this.count++;
  }

  private grow(cap: number): void {
    this.capacity = cap;
    this.arrays = this.arrays.map((a, i) => {
      const b = new Float32Array(cap * this.sizes[i]);
      b.set(a);
      return b;
    });
    const old = this.geometry;
    this.geometry = this.makeGeometry();
    this.onGeometry?.(this.geometry);
    old.dispose();
  }

  onGeometry: ((g: THREE.InstancedBufferGeometry) => void) | null = null;

  commit(): void {
    for (let i = 0; i < this.attrs.length; i++) {
      const a = this.attrs[i];
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * this.sizes[i]);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = this.count;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

const TEXT_VERT = /* glsl */ `
attribute vec4 iRect;
attribute vec4 iUv;
attribute vec4 iColor;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec2 p = iRect.xy + position.xy * iRect.zw;
  vUv = mix(iUv.xy, iUv.zw, position.xy);
  vColor = iColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

const TEXT_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float a = texture2D(map, vUv).a * vColor.a * opacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

export type Align = 'left' | 'center' | 'right';

/** Many labels drawn as instanced glyph quads in one draw call. */
export class TextBatch {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private buf: InstanceBuffer;

  constructor(
    public atlas: GlyphAtlas,
    capacity = 1024,
  ) {
    this.buf = new InstanceBuffer(['iRect', 'iUv', 'iColor'], [4, 4, 4], capacity);
    this.material = new THREE.ShaderMaterial({
      vertexShader: TEXT_VERT,
      fragmentShader: TEXT_FRAG,
      uniforms: { map: { value: atlas.texture }, opacity: { value: 1 } },
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

  /**
   * Add a label: `size` is the em size in world units, (x, y) the anchor, with
   * y at the middle of the capitals; `align` places x at the left, centre or right.
   */
  add(text: string, x: number, y: number, size: number, r: number, g: number, b: number, a: number, align: Align = 'center'): void {
    if (a <= 0.003 || size <= 0) return;
    const m = this.atlas.metrics;
    const chars = [...text];
    const adv = m.advance * size;
    const total = chars.length * adv;
    let x0 = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    const cw = m.cellW * size;
    const chh = m.cellH * size;
    const yb = y - m.capMid * size;
    for (const c of chars) {
      if (c !== ' ') {
        // next() may grow (and replace) the arrays, so read them after it.
        const i = this.buf.next();
        const [R, U, C] = this.buf.arrays;
        const uv = this.atlas.uv(c);
        const o = i * 4;
        R[o] = x0 + adv / 2 - cw / 2;
        R[o + 1] = yb;
        R[o + 2] = cw;
        R[o + 3] = chh;
        U[o] = uv[0];
        U[o + 1] = uv[1];
        U[o + 2] = uv[2];
        U[o + 3] = uv[3];
        C[o] = r;
        C[o + 1] = g;
        C[o + 2] = b;
        C[o + 3] = a;
      }
      x0 += adv;
    }
  }

  width(text: string, size: number): number {
    return this.atlas.width(text, size);
  }

  commit(): void {
    this.buf.commit();
  }

  dispose(): void {
    this.buf.dispose();
    this.material.dispose();
  }
}
