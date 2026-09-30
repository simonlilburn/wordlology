<script lang="ts">
  // Owned by the card/atlas agent: compare mode. Two selected cards paired
  // target by target: side-by-side distributions, a histogram of per-target
  // differences in mean guesses (A − B), wins/ties/losses, and the targets
  // with the largest differences (each opens its Tree view for either side).
  import { app } from '../../app/store.svelte';
  import { compareRuns, type Comparison } from '../../model/compare';
  import { cells, gridAxes, type Cell } from '../../scene/atlas/cells';
  import { openTree } from '../../scene/atlas/interact';
  import { sceneView } from '../../scene/atlas/view.svelte';
  import { fmtMean, fmtPercent, rowName } from '../../scene/card/format';
  import { pairCards, pairedCount } from './compare';
  import { binDiffs } from './histogram';

  let { onclose }: { onclose: () => void } = $props();

  interface Side {
    cell: Cell;
    label: string;
    colour: string;
    opener: string | null;
    mean: string;
  }

  const sides = $derived.by((): [Side, Side] | null => {
    void sceneView.tick;
    const sel = app.atlas.selected;
    if (sel.length !== 2) return null;
    const { columns, rows } = gridAxes();
    const out: Side[] = [];
    for (const [c, r] of sel) {
      const s = columns[c], o = rows[r];
      if (!s || o === undefined) return null;
      const cell = cells.get(s, o);
      const snap = cell.snapshot;
      out.push({
        cell,
        label: s.label,
        colour: s.colour,
        opener: o,
        mean: snap && snap.nGames > 0 ? fmtMean(snap.mean, snap.deterministic ? null : snap.meanSe, !snap.complete) : '–',
      });
    }
    return [out[0], out[1]];
  });

  const nTargets = $derived(app.words?.answers.length ?? 0);

  function localCompare(a: Cell, b: Cell): Comparison | null {
    if (!a.acc || !b.acc) return null;
    try {
      return pairCards(a.acc.targetMeans(), b.acc.targetMeans(), a.snapshot?.shares ?? [], b.snapshot?.shares ?? []);
    } catch {
      return null;
    }
  }

  const cmp = $derived.by((): Comparison | null => {
    void sceneView.tick;
    const s = sides;
    if (!s) return null;
    const [a, b] = s;
    const maxG = app.result.maxGuesses;
    if (a.cell.run && b.cell.run) {
      try {
        const c = compareRuns(a.cell.run, b.cell.run, nTargets, maxG);
        if (c && c.diffs && c.diffs.length) return c;
      } catch {
        /* model/compare.ts not available: pair locally */
      }
    }
    return localCompare(a.cell, b.cell);
  });

  const hist = $derived(cmp ? binDiffs(cmp.diffs, 31) : null);
  const paired = $derived(cmp ? pairedCount(cmp.diffs) : 0);

  const rowsView = $derived.by(() => {
    if (!cmp) return [];
    const n = Math.max(cmp.distA.length, cmp.distB.length);
    const maxG = n - 1;
    let max = 0;
    for (const v of [...cmp.distA, ...cmp.distB]) if (v > max) max = v;
    return Array.from({ length: n }, (_, i) => ({
      name: rowName(i, maxG),
      a: cmp.distA[i] ?? 0,
      b: cmp.distB[i] ?? 0,
      wa: max > 0 ? (cmp.distA[i] ?? 0) / max : 0,
      wb: max > 0 ? (cmp.distB[i] ?? 0) / max : 0,
    }));
  });

  function word(t: number): string {
    const w = app.words;
    if (!w || t < 0 || t >= w.answers.length) return `#${t}`;
    return w.guesses[w.answers[t]].toUpperCase();
  }

  function targetMean(cell: Cell, t: number): string {
    try {
      const m = cell.acc?.targetMeans()[t];
      return m !== undefined && Number.isFinite(m) ? m.toFixed(2) : '–';
    } catch {
      return '–';
    }
  }

  const largest = $derived.by(() => {
    void sceneView.tick;
    const s = sides;
    if (!cmp || !s) return [];
    const [a, b] = s;
    const meansA = safeMeans(a.cell), meansB = safeMeans(b.cell);
    return cmp.largest.slice(0, 10).map((t) => ({
      t,
      word: word(t),
      a: meansA ? fmt2(meansA[t]) : targetMean(a.cell, t),
      b: meansB ? fmt2(meansB[t]) : targetMean(b.cell, t),
      d: cmp.diffs[t],
    }));
  });

  function safeMeans(cell: Cell): Float64Array | null {
    try {
      return cell.acc ? cell.acc.targetMeans() : null;
    } catch {
      return null;
    }
  }
  function fmt2(x: number | undefined): string {
    return x !== undefined && Number.isFinite(x) ? x.toFixed(2) : '–';
  }
  function signed(x: number, digits = 2): string {
    if (!Number.isFinite(x)) return '–';
    const s = x.toFixed(digits);
    return x > 0 ? `+${s}` : s.replace('-', '−');
  }

  function openFor(side: 0 | 1, t: number): void {
    const s = sides;
    if (!s) return;
    const { columns, rows } = gridAxes();
    const [c, r] = app.atlas.selected[side];
    const strategy = columns[c], opener = rows[r];
    if (!strategy || opener === undefined) return;
    openTree(JSON.parse(JSON.stringify(strategy)), opener, t);
  }

  // Histogram geometry (SVG units).
  const HW = 340, HH = 120, PAD_B = 22, PAD_T = 6;
  const bars = $derived.by(() => {
    const h = hist;
    if (!h || h.n === 0) return [];
    const nb = h.counts.length;
    const bw = HW / nb;
    return h.counts.map((c, i) => {
      const hgt = h.max > 0 ? ((HH - PAD_B - PAD_T) * c) / h.max : 0;
      const mid = (h.edges[i] + h.edges[i + 1]) / 2;
      return { x: i * bw + 0.5, y: HH - PAD_B - hgt, w: Math.max(1, bw - 1), h: hgt, c, mid, side: mid < -1e-9 ? 'a' : mid > 1e-9 ? 'b' : 'tie' };
    });
  });
  const zeroX = $derived(hist && hist.counts.length ? ((hist.zeroBin + 0.5) * HW) / hist.counts.length : HW / 2);

  const panelStyle = $derived.by(() => {
    const vp = sceneView.vp;
    const W = Math.min(400, Math.max(280, vp.width - 24));
    return `left:${vp.left + 12}px;top:${vp.top + 12}px;width:${W}px;max-height:${Math.max(240, vp.height - 24)}px`;
  });

  function opener(o: string | null): string {
    return o ? o.toUpperCase() : "strategy's choice";
  }

  function keydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<div class="panel" role="dialog" tabindex="-1" aria-label="Compare two cards" style={panelStyle} onkeydown={keydown}>
  <header>
    <h2>Compare</h2>
    <button class="icon" onclick={onclose} aria-label="Close compare">×</button>
  </header>
  {#if !sides}
    <p class="note">Select two cards to compare them (shift-click, or turn on Compare and tap two cards).</p>
  {:else}
    <div class="who">
      {#each sides as s, i (i)}
        <div class="side">
          <span class="tag">{i === 0 ? 'A' : 'B'}</span>
          <span class="swatch" style="background:{s.colour}" aria-hidden="true"></span>
          <span class="label">{s.label}</span>
          <span class="word">{opener(s.opener)}</span>
          <span class="mean">mean {s.mean}</span>
        </div>
      {/each}
    </div>

    {#if cmp}
      <h3>Outcome distributions</h3>
      <table class="dist">
        <thead>
          <tr><th scope="col">Outcome</th><th scope="col">A</th><th scope="col">B</th></tr>
        </thead>
        <tbody>
          {#each rowsView as r (r.name)}
            <tr>
              <th scope="row">{r.name}</th>
              <td>
                <span class="bar" style="width:{(r.wa * 100).toFixed(1)}%;background:{sides[0].colour}" aria-hidden="true"></span>
                <span class="pct">{fmtPercent(r.a)}</span>
              </td>
              <td>
                <span class="bar" style="width:{(r.wb * 100).toFixed(1)}%;background:{sides[1].colour}" aria-hidden="true"></span>
                <span class="pct">{fmtPercent(r.b)}</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h3>Per-target difference in mean guesses (A − B)</h3>
      {#if hist && hist.n > 0}
        <svg viewBox="0 0 {HW} {HH}" class="hist" role="img" aria-label="Histogram of per-target differences A minus B over {paired} targets; left of zero A needs fewer guesses.">
          {#each bars as b, i (i)}
            <rect x={b.x} y={b.y} width={b.w} height={b.h} class="hb {b.side}"><title>{signed(b.mid)}: {b.c} targets</title></rect>
          {/each}
          <line x1={zeroX} x2={zeroX} y1={PAD_T - 4} y2={HH - PAD_B + 3} class="zero" />
          <text x={zeroX} y={HH - 6} text-anchor="middle" class="axis">0</text>
          <text x="2" y={HH - 6} class="axis">{signed(hist.edges[0], 1)}</text>
          <text x={HW - 2} y={HH - 6} text-anchor="end" class="axis">{signed(hist.edges[hist.edges.length - 1], 1)}</text>
        </svg>
        <p class="legend"><span>← A fewer guesses</span><span>B fewer guesses →</span></p>
      {:else}
        <p class="note">Waiting for targets both cards have played…</p>
      {/if}

      <ul class="counts">
        <li><strong>{cmp.wins}</strong> targets where A wins</li>
        <li><strong>{cmp.ties}</strong> ties</li>
        <li><strong>{cmp.losses}</strong> where B wins</li>
      </ul>
      <p class="meandiff">
        Mean difference {signed(cmp.meanDiff, 3)}{#if Number.isFinite(cmp.meanDiffSe)} ± {cmp.meanDiffSe.toFixed(3)} (SE){/if}
        · paired on {paired.toLocaleString('en-US')} / {nTargets.toLocaleString('en-US')} targets
      </p>

      {#if largest.length}
        <h3>Largest differences</h3>
        <table class="largest">
          <thead>
            <tr><th scope="col">Target</th><th scope="col" class="num">A</th><th scope="col" class="num">B</th><th scope="col" class="num">A − B</th><th scope="col"><span class="visually-hidden">Open</span></th></tr>
          </thead>
          <tbody>
            {#each largest as x (x.t)}
              <tr>
                <th scope="row" class="word">{x.word}</th>
                <td class="num">{x.a}</td>
                <td class="num">{x.b}</td>
                <td class="num">{signed(x.d)}</td>
                <td class="open">
                  <button onclick={() => openFor(0, x.t)} aria-label="Open the Tree view of {x.word} for A">Tree A</button>
                  <button onclick={() => openFor(1, x.t)} aria-label="Open the Tree view of {x.word} for B">Tree B</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else}
      <p class="note">Waiting for games…</p>
    {/if}
  {/if}
</div>

<style>
  .panel {
    position: fixed;
    z-index: 14;
    overflow-y: auto;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 12px 36px rgb(0 0 0 / 0.22);
    padding: 0 14px 14px;
    font-size: 13px;
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: center;
    position: sticky;
    top: 0;
    background: var(--bg);
    margin: 0 -14px;
    padding: 4px 4px 0 14px;
  }
  h2 {
    flex: 1;
    font-size: 15px;
    margin: 0;
  }
  h3 {
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
    margin: 14px 0 6px;
  }
  .icon {
    width: 44px;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 22px;
    cursor: pointer;
  }
  .who {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .side {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .tag {
    font-weight: 700;
    width: 14px;
  }
  .swatch {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }
  .label {
    font-weight: 600;
  }
  .word {
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }
  .mean {
    color: var(--muted);
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 2px 4px;
    text-align: left;
    font-weight: 400;
    border-bottom: 1px solid var(--line);
  }
  thead th {
    color: var(--muted);
    font-size: 11.5px;
    font-weight: 600;
  }
  .dist td {
    width: 42%;
    position: relative;
  }
  .bar {
    display: inline-block;
    height: 8px;
    max-width: calc(100% - 52px);
    vertical-align: middle;
    border-radius: 1px;
    opacity: 0.85;
    transition: width 300ms ease-out;
  }
  .pct {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    margin-left: 4px;
  }
  .hist {
    width: 100%;
    height: auto;
    display: block;
  }
  .hb.a {
    fill: var(--correct);
  }
  .hb.b {
    fill: var(--accent);
  }
  .hb.tie {
    fill: var(--muted);
  }
  .zero {
    stroke: var(--fg);
    stroke-width: 1;
  }
  .axis {
    font-size: 10px;
    fill: var(--muted);
  }
  .legend {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    font-size: 11px;
    margin: 2px 0 0;
  }
  .counts {
    list-style: none;
    padding: 0;
    margin: 10px 0 4px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .meandiff {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .open {
    white-space: nowrap;
    text-align: right;
  }
  .open button {
    min-height: 32px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
    color: var(--fg);
    cursor: pointer;
    font-size: 11.5px;
  }
  .note {
    color: var(--muted);
  }
</style>
