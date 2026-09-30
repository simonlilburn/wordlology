// The tree layer (Level 1): every game the focused configuration plays
// against the focused target, grown downward from the opener around the
// trunk, plus the Game → Tree transition. It owns the orthographic camera for
// z ≤ 1 and keeps drawing (fading) the tree for 1 < z < 1.8.

import * as THREE from 'three';
import { selectNode, setLevel } from '../../app/actions';
import { app } from '../../app/store.svelte';
import { zoomByWheel } from '../../app/zoom';
import { compileFilter, matchesNode, type CompiledFilter } from '../../model/filter';
import { focusData } from '../../model/focus';
import type { TargetTree, TrieNode } from '../../model/types';
import { paneState } from '../../panes/state.svelte';
import { glyphAtlas, TextBatch } from '../core/glyphs';
import { palette } from '../core/palette';
import { QuadBatch } from '../core/quads';
import { RibbonBuilder, RibbonMesh } from '../core/ribbons';
import type { FrameInfo, SceneContext, SceneLayer, ScenePointerEvent } from '../types';
import { setTreeBounds } from './bounds';
import {
  approach,
  clampToBounds,
  fitCamera,
  fitScale,
  homeCamera,
  layoutScale,
  MAX_SCALE,
  worldToScreen as camToScreen,
  zoomAt,
  type Bounds,
  type CamState,
  type Viewport,
} from './camera';
import { registerTreeControls, playNode } from './controls';
import { drawTree, nodeGeom, type GeomCache } from './draw';
import { computeTreeFilter, revealMatchIds, type TreeFilter } from './filtering';
import { ellipsisSlotPx, hitTest, type Hit } from './geom';
import { growthTiming, advanceClock, revealCount, type GrowthTiming } from './growth';
import { extendHeaviest, layoutTree, pathOf, type Layout, type LayoutParams } from './layout';
import { Morph, type DNode } from './morph';
import { RevealState } from './reveal';
import { CHOREO, measureBoard, rowProgress, smoothstep, type BoardRow } from './transition';
import { setComputing, setMinimap, setTooltip, setUi, setViewport, silhouette, treeUi } from './ui.svelte';

/** Screen px kept free on the left for the band labels ("GUESS 1"). */
const GUTTER = 60;
/** Screen px between the tree and the edges of its viewport. */
const SIDE_MARGIN = 12;
const HEADER_H = 30;
const MIN_LABEL = 56;
const MAX_CHILDREN = 12;
/** Data relayouts (streaming, growth) at most this often (ms). */
const DATA_RELAYOUT_MS = 90;
const MORPH_MS = 380;
const TARGET_MORPH_MS = 650;
const GROWTH_MORPH_MS = 240;
const LATER_DRAW_MS = 260;

const numberFmt = typeof Intl !== 'undefined' ? new Intl.NumberFormat('en-US') : null;
const fmtInt = (n: number) => (numberFmt ? numberFmt.format(n) : String(n));

let riverPxPerGame = 0;
/** River width scale on screen: CSS px per game at the current zoom (0 when no tree is drawn). */
export function riverScale(): number {
  return riverPxPerGame;
}

type GrowthPhase = 'pending' | 'running' | 'done';

interface HoverRef {
  key: string;
  node: number;
  kind: 'node' | 'ellipsis' | 'out';
}

function isFinalGuess(n: TrieNode, solvedCode: number): boolean {
  return n.pattern === solvedCode;
}

class TreeLayer implements SceneLayer {
  name = 'tree';
  private group = new THREE.Group();
  private atlas = glyphAtlas();
  private rulesQ = new QuadBatch(32);
  private ribbons = new RibbonBuilder();
  private ribbonMesh = new RibbonMesh();
  private quads = new QuadBatch(1024);
  private text: TextBatch;
  private bandQ = new QuadBatch(16);
  private bandT: TextBatch;
  private tileQ = new QuadBatch(64);
  private tileT: TextBatch;
  private ctx: SceneContext | null = null;
  private added = false;

  // Camera.
  private cam: CamState = { cx: 0, cy: 0, s: 1 };
  private camTarget: CamState | null = null;
  private camInit = false;
  /** The tree's viewport: the uncovered canvas region right of the band-label gutter (camera, fit and layout use it). */
  private vp: Viewport = { left: 0, top: 0, width: 1, height: 1 };
  /** The whole uncovered canvas region (DOM overlays, band labels). */
  private fullVp: Viewport = { left: 0, top: 0, width: 1, height: 1 };
  private width = 1;
  private height = 1;

  // Data.
  private tree: TargetTree | null = null;
  private treeVersion = -1;
  private reveal: RevealState | null = null;
  private growth: { phase: GrowthPhase; clock: number; stalled: boolean; timing: GrowthTiming | null; fadeStart: number } = {
    phase: 'done',
    clock: 0,
    stalled: false,
    timing: null,
    fadeStart: -Infinity,
  };
  private expanded = new Map<number, number>();
  private expandVersion = 0;
  private revealIds: number[] = [];
  private revealHandled = 0;
  private playerLeaves: TrieNode[] = [];
  private playerScanVersion = -1;

  // Filter.
  private filterKey = '';
  private compiled: CompiledFilter | null = null;
  private filterData: TreeFilter | null = null;
  private filterDataKey = '';

  // Layout.
  private layout: Layout | null = null;
  private structKey = '';
  private dataKey = '';
  private lastLayoutAt = -Infinity;
  private params: LayoutParams | null = null;
  private trunkIds: number[] = [];
  private morph = new Morph();
  private geomCache: GeomCache = new Map();
  private boundsCur: Bounds = { minX: -400, maxX: 400, top: HEADER_H, bottom: -500 };

  // Interaction.
  private hover: HoverRef | null = null;
  private pinned: HoverRef | null = null;
  private pressed = false;
  private last = { x: 0, y: 0 };
  private lastClick: { t: number; hit: Hit | null } = { t: -Infinity, hit: null };

  // Transition.
  private zPrev = 0;
  private atGame = true;
  private board: { target: number; rows: BoardRow[] } | null = null;

  // Redraw bookkeeping.
  private drawKey = '';
  private silhouetteKey = '';
  private uiVersionAt = -Infinity;
  private uiTreeVersion = -1;
  private now = 0;

  constructor() {
    this.text = new TextBatch(this.atlas, 2048);
    this.bandT = new TextBatch(this.atlas, 64);
    this.tileT = new TextBatch(this.atlas, 64);
    const meshes: [THREE.Object3D, number][] = [
      [this.rulesQ.mesh, 1],
      [this.ribbonMesh.mesh, 2],
      [this.quads.mesh, 3],
      [this.text.mesh, 4],
      [this.bandQ.mesh, 5],
      [this.bandT.mesh, 6],
      [this.tileQ.mesh, 7],
      [this.tileT.mesh, 8],
    ];
    for (const [m, order] of meshes) {
      m.renderOrder = order;
      this.group.add(m);
    }
    this.group.name = 'tree';
    registerTreeControls({
      zoomIn: () => this.zoomButton(1.6),
      zoomOut: () => this.zoomButton(1 / 1.6),
      fit: () => this.fit(),
      skip: () => this.skipGrowth(),
      panTo: (wx, wy, animate) => this.panTo(wx, wy, animate),
      unpin: () => {
        this.pinned = null;
        this.wake();
      },
      expand: (id) => this.expandNode(id),
      reveal: (id) => this.revealNode(id),
    });
  }

  private wake(): void {
    this.drawKey = '';
    this.ctx?.requestRender();
  }

  /** Dev and end-to-end tests: every drawn node with its screen box (CSS px). */
  debugNodes(): { key: string; kind: string; word: string; id: number; x: number; y: number; w: number; h: number; mode: string; trunk: boolean }[] {
    const words = app.words;
    const out: ReturnType<TreeLayer['debugNodes']> = [];
    if (!words) return out;
    for (const d of this.morph.order) {
      if (d.dying || d.l.kind === 'root') continue;
      const g = this.geomCache.get(d);
      const p = camToScreen(this.cam, this.vp, d.x, d.y);
      const t = d.l.trie;
      out.push({
        key: d.key,
        kind: d.l.kind,
        word: t && d.l.kind === 'node' ? (words.guesses[t.guess] ?? '') : '',
        id: t ? t.id : -1,
        x: p.x,
        y: p.y,
        w: g ? g.w * this.cam.s : 0,
        h: g ? g.h * this.cam.s : 0,
        mode: g ? g.mode : 'hidden',
        trunk: d.l.trunk,
      });
    }
    return out;
  }

  /** Dev and end-to-end tests: camera, growth and layout state. */
  debugState(): Record<string, unknown> {
    return {
      cam: { ...this.cam },
      vp: { ...this.vp },
      bounds: { ...this.boundsCur },
      growth: this.growth.phase,
      revealed: this.reveal?.count ?? 0,
      nodes: this.layout?.nodes.length ?? 0,
      riverScale: riverPxPerGame,
    };
  }

  // ---------------------------------------------------------------- frame

  update(f: FrameInfo, ctx: SceneContext): boolean {
    this.ctx = ctx;
    this.now = f.time;
    if (!this.added) {
      ctx.scene.add(this.group);
      this.added = true;
    }
    const z = f.z;
    this.width = f.width;
    this.height = f.height;
    const v = ctx.viewport;
    this.fullVp = v && v.width > 20 && v.height > 20 ? { ...v } : { left: 0, top: 0, width: f.width, height: f.height };
    const gutter = Math.min(GUTTER, this.fullVp.width * 0.2);
    this.vp = { ...this.fullVp, left: this.fullVp.left + gutter, width: Math.max(1, this.fullVp.width - gutter) };
    setViewport(this.fullVp);

    const words = app.words;
    const visible = !!words && z > 0.015 && z < 1.85;
    if (z <= 0.015) {
      this.atGame = true;
      this.board = null;
    }
    if (!visible || !words) {
      this.group.visible = false;
      this.publishInactive();
      this.zPrev = z;
      riverPxPerGame = 0;
      if (!this.tree || !words) setTreeBounds(null);
      return false;
    }
    this.group.visible = true;
    let animating = false;

    // Game → Tree: measure the board at the start of each transition.
    if (z < 1 && (this.atGame || this.zPrev >= 1 || !this.board)) {
      if (this.atGame || this.zPrev >= 1 || this.zPrev <= 0.015) this.board = measureBoard(ctx.renderer.domElement, words);
      if (this.atGame) this.camInit = false;
    }
    const fromGame = this.atGame;
    if (z >= 0.999) this.atGame = false;

    this.syncTree(f, fromGame);
    const tree = this.tree;
    if (!tree) {
      this.group.visible = false;
      this.publishInactive();
      this.zPrev = z;
      return false;
    }

    // Growth.
    if (this.stepGrowth(f)) animating = true;

    // Layout.
    const relaid = this.maybeLayout(f);
    if (this.morph.step(this.now)) animating = true;
    if (relaid && this.morph.animating) animating = true;

    // Camera (the tree layer owns it for z ≤ 1).
    if (z <= 1) {
      if (!this.camInit || !Number.isFinite(this.cam.s)) {
        this.cam = homeCamera(this.boundsCur, this.vp);
        this.camTarget = null;
        this.camInit = true;
      }
      if (this.camTarget) {
        if (f.reducedMotion || approach(this.cam, this.camTarget, f.dt)) {
          if (f.reducedMotion) this.cam = { ...this.camTarget };
          this.camTarget = null;
        } else animating = true;
      }
      this.applyCamera(ctx);
    }

    // Geometry.
    if (this.reveal?.drawing(this.now)) animating = true;
    if (f.reducedMotion && this.now - this.growth.fadeStart < 220) animating = true;
    this.draw(f, ctx, z);
    this.publish(f, ctx, z);
    this.zPrev = z;
    return animating;
  }

  private publishInactive(): void {
    setUi('active', false);
    setUi('alpha', 0);
    setUi('growing', false);
    setUi('stalled', false);
    setComputing(null);
    setTooltip(null);
    if (treeUi.minimap.show) setMinimap({ ...treeUi.minimap, show: false }, false);
  }

  // ----------------------------------------------------------------- data

  private syncTree(f: FrameInfo, fromGame: boolean): void {
    const tree = focusData.tree;
    if (tree !== this.tree) {
      const old = this.tree;
      this.tree = tree;
      this.treeVersion = -1;
      this.expanded.clear();
      this.expandVersion++;
      this.revealIds = [];
      this.revealHandled = paneState.revealRequest;
      this.pinned = null;
      this.hover = null;
      this.filterDataKey = '';
      this.playerScanVersion = -1;
      this.layout = null;
      this.structKey = '';
      this.dataKey = '';
      if (!tree) {
        this.reveal = null;
        this.morph.clear();
        setTreeBounds(null);
        return;
      }
      this.reveal = new RevealState(tree);
      const mode = app.display.growthAnimation;
      const timing = growthTiming(mode);
      // Grow after the Game → Tree transition; otherwise show the games as they are computed.
      const grow = fromGame && app.z < 0.98 && !!timing && !f.reducedMotion;
      this.growth = { phase: grow ? 'pending' : 'done', clock: 0, stalled: false, timing, fadeStart: f.reducedMotion ? this.now : -Infinity };
      // A new target morphs from the old tree (the root stays anchored); otherwise start fresh.
      const morphing = !!old && app.z > 0.5 && !f.reducedMotion;
      if (!morphing) this.morph.clear();
      this.morphDur = morphing ? TARGET_MORPH_MS : 0;
    }
    if (!tree) return;
    if (tree.version !== this.treeVersion) {
      this.treeVersion = tree.version;
      const r = this.reveal!;
      r.setTrunk(this.trunkGuesses(tree));
      r.scan();
    }
  }

  private morphDur = 0;

  private trunkGuesses(tree: TargetTree): number[] {
    const id = app.focus.node;
    if (id >= 0 && id < tree.nodes.length) return pathOf(tree.nodes[id]).map((n) => n.guess);
    const pl = this.latestPlayerLeaf(tree);
    return pl ? pathOf(pl).map((n) => n.guess) : [];
  }

  private scanPlayers(tree: TargetTree): void {
    if (this.playerScanVersion === tree.version) return;
    this.playerScanVersion = tree.version;
    const leaves: TrieNode[] = [];
    for (const n of tree.nodes) {
      if (!n.player || n.parent === null) continue;
      if (!n.children.some((c) => c.player)) leaves.push(n);
    }
    this.playerLeaves = leaves;
  }

  private latestPlayerLeaf(tree: TargetTree): TrieNode | null {
    this.scanPlayers(tree);
    return this.playerLeaves.length ? this.playerLeaves[this.playerLeaves.length - 1] : null;
  }

  private runTotal(tree: TargetTree): number {
    const run = focusData.treeRun;
    const t = run?.progress?.total ?? run?.config.replicates ?? 0;
    return Math.max(1, t, tree.totalMass);
  }

  private runDone(): boolean {
    const run = focusData.treeRun;
    return !run || run.status === 'done' || run.status === 'error' || run.status === 'cancelled';
  }

  private stepGrowth(f: FrameInfo): boolean {
    const tree = this.tree!;
    const r = this.reveal!;
    const g = this.growth;
    if (g.phase === 'pending') {
      if (app.z >= 0.98 && !app.zDragging) {
        g.phase = 'running';
        g.clock = 0;
      } else return false;
    }
    if (g.phase === 'running' && g.timing) {
      const total = this.runTotal(tree);
      const res = advanceClock(g.clock, f.dt, total, r.available, this.runDone(), g.timing);
      g.clock = res.clock;
      g.stalled = res.stalled;
      let want = revealCount(g.clock, total, g.timing);
      while (r.count < want) {
        const i = r.count;
        const first = i < g.timing.firstCount;
        const drawMs = first ? g.timing.drawFirstMs : g.timing.drawLaterMs;
        if (!r.revealNext(this.now, drawMs)) break;
        // A slow, one-at-a-time slot is only worth spending on a game that
        // adds something to the picture: one that retraces paths already on
        // screen (the trunk, at first) passes straight to the next game.
        if (first && r.lastFresh === 0 && r.count < total) {
          g.clock = Math.max(g.clock, r.count * g.timing.firstMs);
          want = revealCount(g.clock, total, g.timing);
        }
      }
      if (r.count >= total || (this.runDone() && r.pending === 0 && r.count >= r.available)) {
        g.phase = 'done';
        g.stalled = false;
      }
      return true;
    }
    // Done: reveal whatever arrives (drawn on quickly).
    if (r.pending > 0) {
      const reduced = f.reducedMotion;
      r.revealAll(this.now, reduced || !g.timing ? 0 : Math.min(LATER_DRAW_MS, g.timing.drawLaterMs));
      return true;
    }
    return false;
  }

  private skipGrowth(): void {
    const g = this.growth;
    if (g.phase === 'done') return;
    g.phase = 'done';
    g.stalled = false;
    this.reveal?.revealAll(this.now, 180);
    this.wake();
  }

  // --------------------------------------------------------------- filter

  private updateFilter(tree: TargetTree, massOf: (n: TrieNode) => number, solvedCode: number): TreeFilter | null {
    const words = app.words!;
    const st = app.filter;
    const key = st ? `${st.text}|${st.combine}|${st.mode}|${st.rows.join(',')}|${st.includeFinal}|${app.display.yIsVowel}|${words.wordLength}` : '';
    if (key !== this.filterKey) {
      this.filterKey = key;
      this.revealIds = [];
      try {
        this.compiled = st ? compileFilter(st, words.wordLength, app.display.yIsVowel) : null;
      } catch {
        this.compiled = null;
      }
      this.filterDataKey = '';
    }
    const cf = this.compiled;
    if (!cf) {
      this.filterData = null;
      return null;
    }
    const dk = `${key}|${tree.version}|${this.reveal?.count ?? 0}`;
    if (dk !== this.filterDataKey) {
      this.filterDataKey = dk;
      const g = words.guesses;
      try {
        this.filterData = computeTreeFilter(tree.root, tree.nodes.length, (n) => matchesNode(cf, g[n.guess] ?? '', n.depth, isFinalGuess(n, solvedCode)), cf.mode, app.result.maxGuesses, massOf);
      } catch {
        this.filterData = null;
      }
    }
    // "Reveal matches" from the filter pane.
    const req = paneState.revealRequest;
    if (req !== this.revealHandled) {
      this.revealHandled = req;
      if (paneState.revealTarget === tree.target && paneState.revealFilter === (app.filter?.text ?? '') && this.filterData) {
        this.revealIds = revealMatchIds(tree.root, this.filterData, 50);
      }
    }
    return this.filterData;
  }

  // --------------------------------------------------------------- layout

  private layoutParams(tree: TargetTree): LayoutParams {
    const words = app.words!;
    const N = app.result.maxGuesses;
    const vp = this.vp;
    const width = Math.max(240, vp.width - 2 * SIDE_MARGIN);
    const bandHeight = Math.round(Math.min(84, Math.max(44, (vp.height - 40 - HEADER_H) / (N + 1))));
    const total = this.runTotal(tree);
    return {
      maxGuesses: N,
      totalGames: total,
      width,
      scale: layoutScale(this.cam.s),
      minLabel: MIN_LABEL,
      maxChildren: MAX_CHILDREN,
      expandStep: MAX_CHILDREN,
      bandHeight,
      headerHeight: HEADER_H,
      riverScale: Math.min(4, (0.16 * width) / total),
      solvedCode: Math.pow(3, words.wordLength) - 1,
    };
  }

  private maybeLayout(f: FrameInfo): boolean {
    const tree = this.tree!;
    const r = this.reveal!;
    const params = this.layoutParams(tree);
    const massOfReveal = r.massOf;
    const filter = this.updateFilter(tree, massOfReveal, params.solvedCode);
    const isolate = filter && filter.mode === 'isolate';
    const massOf = isolate ? (n: TrieNode) => filter.fmass[n.id] ?? 0 : massOfReveal;
    // Trunk: the selected path (or the player's), extended along the heaviest children.
    const id = app.focus.node;
    let base: TrieNode[] = [];
    if (id >= 0 && id < tree.nodes.length) base = pathOf(tree.nodes[id]);
    else {
      const pl = this.latestPlayerLeaf(tree);
      if (pl) base = pathOf(pl);
    }
    const trunk = extendHeaviest(base, tree.root, massOf);
    this.scanPlayers(tree);
    const forced: number[] = [];
    for (const n of this.playerLeaves) forced.push(n.id);
    if (id >= 0) forced.push(id);
    for (const x of this.revealIds) forced.push(x);
    for (const n of trunk) r.showNow(n);
    for (const n of this.playerLeaves) for (let x: TrieNode | null = n; x; x = x.parent) r.showNow(x);

    const structKey = [
      tree.target,
      trunk.map((n) => n.id).join('.'),
      this.expandVersion,
      this.filterKey,
      this.revealIds.length,
      params.scale,
      params.width,
      params.bandHeight,
      params.maxGuesses,
      forced.length,
      app.display.labelThreshold,
    ].join('|');
    const dataKey = `${tree.version}|${r.count}|${params.totalGames}`;
    const structChanged = structKey !== this.structKey;
    const dataChanged = dataKey !== this.dataKey;
    if (!structChanged && !dataChanged && this.layout) return false;
    if (!structChanged && this.layout && this.now - this.lastLayoutAt < DATA_RELAYOUT_MS) return false;
    const advance = this.atlas.metrics.advance;
    const threshold = app.display.labelThreshold;
    const layout = layoutTree({
      root: tree.root,
      params,
      massOf,
      trunk,
      forced,
      expanded: this.expanded,
      matchesBelow: filter ? (n) => filter.below[n.id] ?? 0 : undefined,
      ellipsisPx: (count, games) => ellipsisSlotPx(count, games, advance, threshold, fmtInt),
    });
    const first = !this.layout;
    this.layout = layout;
    this.params = params;
    this.trunkIds = trunk.map((n) => n.id);
    this.structKey = structKey;
    this.dataKey = dataKey;
    this.lastLayoutAt = this.now;
    let dur = structChanged ? MORPH_MS : GROWTH_MORPH_MS;
    if (first) dur = this.morphDur;
    if (f.reducedMotion) dur = 0;
    this.morph.setLayout(layout, this.now, dur);
    this.morphDur = MORPH_MS;
    this.boundsCur = { minX: layout.minX, maxX: layout.maxX, top: layout.top, bottom: layout.bottom };
    setTreeBounds({ x: layout.minX, y: layout.bottom, width: layout.maxX - layout.minX, height: layout.top - layout.bottom });
    if (this.pinned && !layout.byKey.has(this.pinned.key)) this.pinned = null;
    if (this.hover && !layout.byKey.has(this.hover.key)) this.hover = null;
    return true;
  }

  // --------------------------------------------------------------- camera

  private minScale(): number {
    return fitScale(this.boundsCur, this.vp);
  }

  private applyCamera(ctx: SceneContext): void {
    const o = ctx.ortho;
    const W = this.width;
    const H = this.height;
    const c = this.cam;
    const vx = this.vp.left + this.vp.width / 2;
    const vy = this.vp.top + this.vp.height / 2;
    o.left = -W / 2;
    o.right = W / 2;
    o.top = H / 2;
    o.bottom = -H / 2;
    o.zoom = c.s;
    o.position.set(c.cx - (vx - W / 2) / c.s, c.cy + (vy - H / 2) / c.s, 100);
    o.rotation.set(0, 0, 0);
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
    ctx.camera = 'ortho';
  }

  private setCam(c: CamState, animate: boolean): void {
    const clamped = clampToBounds(c, this.boundsCur);
    if (animate && !app.reducedMotion) this.camTarget = clamped;
    else {
      this.cam = clamped;
      this.camTarget = null;
    }
    this.wake();
  }

  private zoomButton(factor: number): void {
    if (Math.abs(app.z - 1) > 0.05) return;
    const base = this.camTarget ?? this.cam;
    const minS = this.minScale();
    if (factor < 1 && base.s <= minS * 1.001) {
      // Already at the fit scale: − continues to the Card level.
      setLevel(2);
      return;
    }
    const v = { x: this.vp.left + this.vp.width / 2, y: this.vp.top + this.vp.height / 2 };
    const { cam } = zoomAt(base, this.vp, factor, v.x, v.y, minS);
    this.setCam(cam, true);
  }

  private fit(): void {
    this.setCam(fitCamera(this.boundsCur, this.vp), true);
  }

  private panTo(wx: number, wy: number, animate: boolean): void {
    const base = this.camTarget ?? this.cam;
    this.setCam({ cx: wx, cy: wy, s: base.s }, animate);
  }

  // ----------------------------------------------------------- interaction

  private hitAt(e: { x: number; y: number; world: { x: number; y: number }; pointerType: string }): Hit | null {
    if (!this.layout || this.cam.s <= 0) return null;
    const words = app.words;
    if (!words) return null;
    const params = this.params;
    if (!params) return null;
    const inp = { s: this.cam.s, threshold: app.display.labelThreshold, advance: this.atlas.metrics.advance, words: words.guesses, fmtInt, params };
    return hitTest(this.morph.order, e.world.x, e.world.y, this.cam.s, e.pointerType === 'touch' ? 44 : 28, (d) => nodeGeom(d, inp));
  }

  private refOf(h: Hit): HoverRef | null {
    const d = h.d;
    if (d.l.kind === 'ellipsis') {
      const p = d.parent?.l.trie;
      return p ? { key: d.key, node: p.id, kind: 'ellipsis' } : null;
    }
    const t = d.l.trie;
    if (!t) return null;
    return { key: d.key, node: t.id, kind: d.l.kind === 'out' ? 'out' : 'node' };
  }

  private expandNode(parentId: number): void {
    this.expanded.set(parentId, (this.expanded.get(parentId) ?? 0) + 1);
    this.expandVersion++;
    this.pinned = null;
    this.wake();
  }

  private revealNode(nodeId: number): void {
    const tree = this.tree;
    if (!tree || nodeId < 0 || nodeId >= tree.nodes.length) return;
    selectNode(nodeId);
    this.pinned = null;
    this.setCam({ ...(this.camTarget ?? this.cam), cx: 0 }, true);
  }

  private interactive(): boolean {
    return !!this.tree && !!this.layout && Math.abs(app.z - 1) < 0.2 && this.ctx?.camera === 'ortho';
  }

  pointer(e: ScenePointerEvent, ctx: SceneContext): boolean {
    if (!this.interactive()) {
      if (this.hover) {
        this.hover = null;
        this.setHoverNode(-1);
      }
      this.pressed = false;
      return false;
    }
    switch (e.kind) {
      case 'down': {
        this.pressed = true;
        this.last = { x: e.x, y: e.y };
        return true;
      }
      case 'move': {
        if (this.pressed) {
          const dx = e.x - this.last.x;
          const dy = e.y - this.last.y;
          this.last = { x: e.x, y: e.y };
          const s = this.cam.s;
          this.camTarget = null;
          this.cam = clampToBounds({ cx: this.cam.cx - dx / s, cy: this.cam.cy + dy / s, s }, this.boundsCur);
          if (this.hover) {
            this.hover = null;
            this.setHoverNode(-1);
          }
          this.wake();
          return true;
        }
        if (e.pointerType === 'touch') return false;
        const h = this.hitAt(e);
        const ref = h ? this.refOf(h) : null;
        if ((ref?.key ?? '') !== (this.hover?.key ?? '')) {
          this.hover = ref;
          this.setHoverNode(ref && ref.kind !== 'ellipsis' ? ref.node : -1);
          this.wake();
        }
        ctx.renderer.domElement.style.cursor = ref ? 'pointer' : 'grab';
        return !!ref;
      }
      case 'up': {
        this.pressed = false;
        return true;
      }
      case 'leave': {
        this.pressed = false;
        if (this.hover) {
          this.hover = null;
          this.setHoverNode(-1);
          this.wake();
        }
        return false;
      }
      case 'click':
      case 'longpress': {
        if (this.growth.phase !== 'done') this.skipGrowth();
        const h = this.hitAt(e);
        this.lastClick = { t: this.now, hit: h };
        if (!h) {
          if (this.pinned) {
            this.pinned = null;
            this.wake();
          }
          return true;
        }
        const ref = this.refOf(h);
        if (!ref) return true;
        if (ref.kind === 'ellipsis') {
          this.expandNode(ref.node);
          return true;
        }
        selectNode(ref.node);
        this.pinned = ref;
        this.hover = null;
        this.setHoverNode(-1);
        // The selected path becomes the trunk at x = 0: bring it to the centre.
        this.setCam({ ...(this.camTarget ?? this.cam), cx: 0 }, true);
        return true;
      }
      case 'dblclick': {
        let h = this.hitAt(e);
        if (this.now - this.lastClick.t < 500 && this.lastClick.hit) h = this.lastClick.hit;
        const ref = h ? this.refOf(h) : null;
        if (ref && ref.kind !== 'ellipsis') {
          playNode(ref.node);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  private setHoverNode(id: number): void {
    if (app.focus.hoverNode !== id) app.focus.hoverNode = id;
  }

  wheel(e: { x: number; y: number; deltaY: number; ctrlKey: boolean }, ctx: SceneContext): boolean {
    if (!this.tree || !this.layout) return false;
    const z = app.z;
    if (z < 0.999 || z > 1.6) return false;
    const dz = e.deltaY * (e.ctrlKey ? 0.01 : 0.0025);
    if (!Number.isFinite(dz) || dz === 0) return true;
    if (z > 1.0005) {
      // Inside a level gesture: out continues; in comes back to the tree first.
      if (dz > 0) {
        zoomByWheel(dz);
        return true;
      }
      const step = Math.max(dz, 1 - z);
      zoomByWheel(step);
      const rest = dz - step;
      if (rest < 0) this.zoomCamAt(Math.exp(-rest), e.x, e.y);
      return true;
    }
    if (ctx.camera !== 'ortho') return false;
    const leftover = this.zoomCamAt(Math.exp(-dz), e.x, e.y);
    if (leftover < 0.999) zoomByWheel(-Math.log(leftover));
    return true;
  }

  /** Zoom the tree camera about a screen point; returns the factor that did not fit (< 1 past the fit scale). */
  private zoomCamAt(factor: number, sx: number, sy: number): number {
    const minS = this.minScale();
    const base = this.camTarget ?? this.cam;
    const { cam, rest } = zoomAt(base, this.vp, factor, sx, sy, minS);
    this.cam = clampToBounds(cam, this.boundsCur);
    this.camTarget = null;
    this.wake();
    return rest;
  }

  resize(): void {
    this.drawKey = '';
  }

  // ------------------------------------------------------------------ draw

  private hoverSet(): { ids: Set<number>; key: string | null } {
    const tree = this.tree;
    const ref = this.hover ?? this.pinned;
    const ids = new Set<number>();
    if (!tree || !ref) return { ids, key: null };
    if (ref.kind === 'ellipsis') return { ids, key: ref.key };
    const n = tree.nodes[ref.node];
    for (let x: TrieNode | null = n ?? null; x; x = x.parent) ids.add(x.id);
    return { ids, key: null };
  }

  private viewRect(ctx: SceneContext, z: number): { x0: number; x1: number; y0: number; y1: number } {
    if (z <= 1 && ctx.camera === 'ortho') {
      const a = ctx.screenToWorld(0, 0);
      const b = ctx.screenToWorld(this.width, this.height);
      return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
    }
    const bd = this.boundsCur;
    const m = 400;
    return { x0: bd.minX - m, x1: bd.maxX + m, y0: bd.bottom - m, y1: bd.top + m };
  }

  private draw(f: FrameInfo, ctx: SceneContext, z: number): void {
    const words = app.words!;
    const tree = this.tree!;
    const params = this.params;
    if (!params) return;
    const pal = palette();
    const reduced = f.reducedMotion;
    // Level fades.
    let alpha = 1;
    let labelAlpha = 1;
    let branchAlpha = 1;
    let trunkLabelAlpha = 1;
    let trunkProgress = 1;
    let rulesProgress = 1;
    let bandLabelAlpha = 1;
    const tilesMatch = !!this.board && this.board.target === tree.target;
    if (z > 1) {
      alpha = 1 - smoothstep(1, 1.8, z);
      labelAlpha = 1 - smoothstep(1, 1.4, z);
    } else if (reduced) {
      alpha = smoothstep(0, 1, z);
    } else {
      branchAlpha = smoothstep(CHOREO.branches[0], CHOREO.branches[1], z);
      trunkLabelAlpha = tilesMatch ? smoothstep(CHOREO.handover[0], CHOREO.handover[1], z) : smoothstep(0.5, 0.9, z);
      trunkProgress = smoothstep(CHOREO.trunk[0], CHOREO.trunk[1], z);
      rulesProgress = smoothstep(CHOREO.rules[0], CHOREO.rules[1], z);
      bandLabelAlpha = smoothstep(CHOREO.bandLabels[0], CHOREO.bandLabels[1], z);
    }
    if (reduced && this.growth.fadeStart > -Infinity) branchAlpha *= Math.min(1, Math.max(0, (this.now - this.growth.fadeStart) / 200));
    const hs = this.hoverSet();
    const view = this.viewRect(ctx, z);
    const bandLabelX = z <= 1 && ctx.camera === 'ortho' ? ctx.screenToWorld(this.fullVp.left + 12, 0).x : this.boundsCur.minX - 70;
    const total = this.runTotal(tree);
    const target = words.guesses[words.answers[tree.target]] ?? '';
    const caption = `${fmtInt(tree.totalMass)} GAME${tree.totalMass === 1 ? '' : 'S'} AGAINST ${target.toUpperCase()}`;
    void total;
    const key = [
      this.cam.cx.toFixed(2),
      this.cam.cy.toFixed(2),
      this.cam.s.toFixed(4),
      z.toFixed(4),
      this.morph.animating ? this.now : 0,
      this.reveal?.drawing(this.now) ? this.now : 0,
      this.structKey,
      this.dataKey,
      pal.key,
      hs.key,
      [...hs.ids].length ? [...hs.ids][0] : -1,
      app.display.labelThreshold,
      this.filterDataKey,
      this.width,
      this.height,
      reduced && this.now - this.growth.fadeStart < 220 ? this.now : 0,
      ctx.camera,
    ].join('|');
    if (key === this.drawKey) return;
    this.drawKey = key;
    drawTree(
      {
        nodes: this.morph.order,
        s: this.cam.s,
        view,
        bandLabelX,
        pal,
        words: words.guesses,
        wordLength: words.wordLength,
        threshold: app.display.labelThreshold,
        advance: this.atlas.metrics.advance,
        params,
        filter: this.filterData,
        hover: hs.ids,
        hoverKey: hs.key,
        reveal: this.reveal,
        now: this.now,
        alpha,
        labelAlpha,
        branchAlpha,
        trunkLabelAlpha,
        trunkProgress,
        rulesProgress,
        bandLabelAlpha,
        caption,
        fmtInt,
      },
      { rules: this.rulesQ, ribbons: this.ribbons, quads: this.quads, text: this.text, bandQuads: this.bandQ, bandText: this.bandT },
      this.geomCache,
    );
    this.drawTiles(ctx, z, reduced, tilesMatch);
    this.rulesQ.commit();
    this.ribbonMesh.upload(this.ribbons);
    this.quads.commit();
    this.text.commit();
    this.bandQ.commit();
    this.bandT.commit();
    this.tileQ.commit();
    this.tileT.commit();
  }

  /** The board's tiles on their way to the trunk's labels (Game → Tree). */
  private drawTiles(ctx: SceneContext, z: number, reduced: boolean, tilesMatch: boolean): void {
    this.tileQ.clear();
    this.tileT.clear();
    const board = this.board;
    if (!board || reduced || z <= CHOREO.tilesIn || z >= CHOREO.handover[1] || ctx.camera !== 'ortho') return;
    const words = app.words!;
    const pal = palette();
    const s = this.cam.s;
    const px = 1 / s;
    const hand = 1 - smoothstep(CHOREO.handover[0], CHOREO.handover[1], z);
    const params = this.params;
    if (!params) return;
    const inp = { s, threshold: 0, advance: this.atlas.metrics.advance, words: words.guesses, fmtInt, params };
    // Trunk display nodes by depth.
    const trunk = new Map<number, DNode>();
    for (const d of this.morph.order) if (d.l.trunk && d.l.kind === 'node' && d.l.trie) trunk.set(d.l.trie.depth, d);
    const len = words.wordLength;
    for (const row of board.rows) {
      const u = rowProgress(z, row.index);
      const d = tilesMatch && row.guess >= 0 ? trunk.get(row.index + 1) : undefined;
      const target = d && d.l.trie && d.l.trie.guess === row.guess ? d : null;
      let g: ReturnType<typeof nodeGeom> | null = null;
      let x0 = 0;
      let wordY = 0;
      let stripY = 0;
      let adv = 0;
      if (target) {
        g = nodeGeom(target, inp);
        adv = this.atlas.metrics.advance * g.font;
        x0 = target.x - (len * adv) / 2;
        const contentH = g.font * 1.05 + 2 * px + g.stripH;
        const top = target.y + contentH / 2;
        wordY = top - g.font * 0.52;
        stripY = top - g.font * 1.05 - 2 * px - g.stripH / 2;
      }
      row.tiles.forEach((tile, j) => {
        const c = ctx.screenToWorld(tile.x + tile.w / 2, tile.y + tile.h / 2);
        const tw = tile.w * px;
        const th = tile.h * px;
        if (tile.cell < 0 || !target || !g) {
          // Unplayed rows (and rows that do not map onto the trunk) fade out in place.
          const a = (1 - smoothstep(0.02, 0.25, z)) * (tile.cell < 0 ? 1 : hand);
          if (tile.cell < 0) quads(this.tileQ, c.x, c.y, tw, th, pal.line, a, 2 * px, 2 * px);
          else {
            quads(this.tileQ, c.x, c.y, tw, th, pal.cells[tile.cell], a, 2 * px, 0);
            this.tileT.add(tile.letter, c.x, c.y, th * 0.5, pal.tileText[0], pal.tileText[1], pal.tileText[2], a);
          }
          return;
        }
        const cx = x0 + (j + 0.5) * adv;
        const cw = Math.max(px, adv - 1.5 * px);
        const col = pal.cells[tile.cell];
        const bx = c.x + (cx - c.x) * u;
        const by = c.y + (stripY - c.y) * u;
        const bw = tw + (cw - tw) * u;
        const bh = th + (g.stripH - th) * u;
        quads(this.tileQ, bx, by, bw, bh, col, hand, (2 + (0.5 - 2) * u) * px, 0);
        const lx = c.x + (cx - c.x) * u;
        const ly = c.y + (wordY - c.y) * u;
        const size = th * 0.5 + (g.font - th * 0.5) * u;
        const lc = [0, 1, 2].map((k) => pal.tileText[k] + (pal.fg[k] - pal.tileText[k]) * u);
        this.tileT.add(tile.letter, lx, ly, size, lc[0], lc[1], lc[2], hand);
      });
    }
  }

  // --------------------------------------------------------------- publish

  private publish(f: FrameInfo, ctx: SceneContext, z: number): void {
    const tree = this.tree!;
    const active = Math.abs(z - 1) < 0.2 && ctx.camera === 'ortho';
    setUi('active', active);
    setUi('alpha', Math.round((1 - smoothstep(0.08, 0.2, Math.abs(z - 1))) * 100) / 100);
    const g = this.growth;
    setUi('growing', g.phase !== 'done' && active);
    setUi('stalled', g.stalled);
    const run = focusData.treeRun;
    const total = this.runTotal(tree);
    if (run && !this.runDone()) setComputing({ done: Math.min(total, run.progress?.done ?? tree.totalMass), total });
    else setComputing(null);
    setUi('deterministic', !!run?.deterministic);
    setUi('games', tree.totalMass);
    const words = app.words!;
    setUi('target', (words.guesses[words.answers[tree.target]] ?? '').toUpperCase());
    const minS = this.minScale();
    setUi('atFit', this.cam.s <= minS * 1.01);
    setUi('atMax', this.cam.s >= MAX_SCALE * 0.99);
    riverPxPerGame = (this.params?.riverScale ?? 0) * (z <= 1 ? this.cam.s : 1);
    // Outline refresh (throttled).
    if (tree.version !== this.uiTreeVersion && this.now - this.uiVersionAt > 400) {
      this.uiTreeVersion = tree.version;
      this.uiVersionAt = this.now;
      treeUi.version++;
    }
    // Tooltip.
    const ref = this.hover ?? this.pinned;
    if (ref && active && this.layout) {
      const d = this.morph.nodes.get(ref.key);
      if (d) {
        const p = camToScreen(this.cam, this.vp, d.x, d.y);
        const gm = this.geomCache.get(d);
        const hh = gm ? (gm.h * this.cam.s) / 2 : 12;
        const hidden = ref.kind === 'ellipsis' ? { count: d.l.hidden?.length ?? 0, games: d.l.hiddenMass, matches: d.l.hiddenMatches } : undefined;
        setTooltip({ node: ref.node, kind: ref.kind, x: p.x, y: p.y + hh, pinned: ref === this.pinned && !this.hover, hidden });
      } else setTooltip(null);
    } else setTooltip(null);
    // Minimap.
    const b = this.boundsCur;
    const s = this.cam.s;
    const overflow = active && ((b.maxX - b.minX) * s > this.vp.width + 2 || (b.top - b.bottom) * s > this.vp.height + 2);
    const fv = this.fullVp;
    const tl = this.screenWorld(fv.left, fv.top);
    const br = this.screenWorld(fv.left + fv.width, fv.top + fv.height);
    const sk = `${this.structKey}|${this.dataKey}|${this.morph.animating ? 1 : 0}`;
    const bump = overflow && sk !== this.silhouetteKey && !this.morph.animating;
    if (bump) {
      this.silhouetteKey = sk;
      this.buildSilhouette();
    }
    setMinimap(
      {
        show: overflow,
        minX: b.minX,
        maxX: b.maxX,
        top: b.top,
        bottom: b.bottom,
        vx0: tl.x,
        vx1: br.x,
        vy0: br.y,
        vy1: tl.y,
        right: this.width - (this.vp.left + this.vp.width) + 16,
        bottom_px: this.height - (this.vp.top + this.vp.height) + 16,
      },
      bump,
    );
  }

  private screenWorld(sx: number, sy: number): { x: number; y: number } {
    const c = this.cam;
    const vx = this.vp.left + this.vp.width / 2;
    const vy = this.vp.top + this.vp.height / 2;
    return { x: c.cx + (sx - vx) / c.s, y: c.cy - (sy - vy) / c.s };
  }

  private buildSilhouette(): void {
    const nodes = this.morph.order.filter((d) => d.parent && !d.dying);
    const segs = new Float32Array(nodes.length * 5);
    let n = 0;
    for (const d of nodes) {
      const p = d.parent!;
      segs[n * 5] = p.x + d.ro;
      segs[n * 5 + 1] = p.y;
      segs[n * 5 + 2] = d.x;
      segs[n * 5 + 3] = d.y;
      segs[n * 5 + 4] = d.rw;
      n++;
    }
    silhouette.segs = segs;
    silhouette.n = n;
  }

  dispose(): void {
    registerTreeControls(null);
    this.ctx?.scene.remove(this.group);
    this.rulesQ.dispose();
    this.ribbonMesh.dispose();
    this.quads.dispose();
    this.text.dispose();
    this.bandQ.dispose();
    this.bandT.dispose();
    this.tileQ.dispose();
    this.tileT.dispose();
    setTreeBounds(null);
  }
}

function quads(q: QuadBatch, x: number, y: number, w: number, h: number, c: readonly number[], a: number, radius: number, stroke: number): void {
  q.add(x, y, w, h, c[0], c[1], c[2], a, radius, stroke);
}

/** The Tree view layer (registered first by createScene). */
export function createTreeLayer(): SceneLayer {
  const layer = new TreeLayer();
  if (import.meta.env?.DEV && typeof window !== 'undefined') (window as unknown as { __wordlologyTree?: TreeLayer }).__wordlologyTree = layer;
  return layer;
}

