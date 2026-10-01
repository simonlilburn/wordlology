// Game → Tree transition (z from 0 to 1): the DOM board is measured and
// replaced by WebGL tiles at the same pixel positions; each row compresses
// into a word label with its feedback strip and slides to its row band; the
// rules draw across left to right; the trunk draws down from the opener; then
// the growth animation starts. Everything is a function of z, so it runs in
// reverse when zooming in and can be interrupted.

import { app } from '../../app/store.svelte';
import { patternCells } from '../../model/feedback';
import type { WordData } from '../../model/types';

export interface BoardTile {
  /** CSS px relative to the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  letter: string;
  /** 0 absent, 1 present, 2 correct; -1 for an unplayed tile. */
  cell: number;
}

export interface BoardRow {
  index: number;
  /** Word id of the row's guess (-1 when the row was not played). */
  guess: number;
  pattern: number;
  tiles: BoardTile[];
}

export function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Choreography on the z axis (0 = Game, 1 = Tree). */
export const CHOREO = {
  /** Tiles appear once the DOM board starts to hide. */
  tilesIn: 0.02,
  /** Row i compresses and slides over [rowStart + i·rowStagger, rowEnd + i·rowStagger]. */
  rowStart: 0.04,
  rowEnd: 0.4,
  rowStagger: 0.03,
  /** Tiles hand over to the tree's own labels. */
  handover: [0.56, 0.64] as const,
  rules: [0.34, 0.68] as const,
  bandLabels: [0.45, 0.75] as const,
  trunk: [0.55, 0.95] as const,
  /** Everything else in the tree fades in. */
  branches: [0.82, 1] as const,
} as const;

/** Progress (0..1) of row i's compression and slide at zoom z. */
export function rowProgress(z: number, i: number): number {
  const d = i * CHOREO.rowStagger;
  return smoothstep(CHOREO.rowStart + d, CHOREO.rowEnd + d, z);
}

/** The guesses and patterns the board shows (the replayed path in replay mode). */
export function boardPath(): { target: number; guesses: number[]; patterns: number[] } | null {
  if (app.replay.active && app.replay.target >= 0) {
    return { target: app.replay.target, guesses: [...app.replay.guesses], patterns: [...app.replay.patterns] };
  }
  const b = app.game.board;
  if (!b) return null;
  return { target: b.target, guesses: [...b.guesses], patterns: [...b.patterns] };
}

/** Measure the DOM board: tile rectangles relative to the canvas, with letters and cells from the store. */
export function measureBoard(canvas: HTMLCanvasElement, words: WordData | null): { target: number; rows: BoardRow[] } | null {
  if (typeof document === 'undefined' || !words) return null;
  const board = document.querySelector('[data-board]');
  const path = boardPath();
  if (!board || !path) return null;
  const c = canvas.getBoundingClientRect();
  const rowEls = board.querySelectorAll('[data-row]');
  const len = words.wordLength;
  const rows: BoardRow[] = [];
  rowEls.forEach((rowEl, idx) => {
    const attr = Number((rowEl as HTMLElement).dataset.row);
    const i = Number.isFinite(attr) ? attr : idx;
    const played = i < path.guesses.length;
    const guess = played ? path.guesses[i] : -1;
    const pattern = played ? path.patterns[i] : 0;
    const word = played ? (words.guesses[guess] ?? '').toUpperCase() : '';
    const cells = played ? patternCells(pattern, len) : [];
    const tiles: BoardTile[] = [];
    rowEl.querySelectorAll('[data-tile]').forEach((t, j) => {
      const r = (t as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      tiles.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, letter: word[j] ?? '', cell: played ? (cells[j] ?? 0) : -1 });
    });
    if (tiles.length) rows.push({ index: i, guess, pattern, tiles });
  });
  return rows.length ? { target: path.target, rows } : null;
}
