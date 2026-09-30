<script lang="ts">
  // Owned by the card/atlas agent: DOM overlays of the Atlas — column headers
  // (strategy name and colour, Rank openers) and row headers (opener, Rank
  // strategies) positioned from the scene's layout → screen transform, the
  // optional mean margins, drag-to-reorder and sorting, the toolbar (Table,
  // Compare, Margins), the table of means (the Level 3 text alternative), and
  // the ranking and compare panels.
  import { tick } from 'svelte';
  import { registerShortcut } from '../../app/keyboard';
  import { app } from '../../app/store.svelte';
  import { openExport } from '../../export';
  import { cells, gridAxes } from '../../scene/atlas/cells';
  import { removeColumn, removeRow } from '../../scene/atlas/interact';
  import { CARD_H, CARD_W, gridLayout } from '../../scene/atlas/layout';
  import { cardUi, sceneView } from '../../scene/atlas/view.svelte';
  import { fmtMean } from '../../scene/card/format';
  import ComparePanel from './ComparePanel.svelte';
  import RankingPanel from './RankingPanel.svelte';
  import { dropIndex, meanOf, moveItem, sortByMean } from './order';

  const level = $derived(Math.round(app.zDragging ? app.z : app.zTarget));
  const shown = $derived(sceneView.visible && sceneView.z > 1.75);
  const atAtlas = $derived(sceneView.visible && level === 3);
  const headerAlpha = $derived(sceneView.visible ? sceneView.headerAlpha : 0);

  const axes = $derived(gridAxes());
  const layout = $derived(gridLayout(axes.columns.length, axes.rows.length));
  const multi = $derived(axes.columns.length * axes.rows.length >= 2);

  interface MeanCell {
    mean: number;
    se: number | null;
    complete: boolean;
    deterministic: boolean;
  }

  // Means per [row][column], refreshed on the scene's data ticks.
  const means = $derived.by((): (MeanCell | null)[][] => {
    void sceneView.tick;
    return axes.rows.map((o) =>
      axes.columns.map((s) => {
        const snap = cells.peek(s.id, o)?.snapshot;
        if (!snap || snap.nGames === 0) return null;
        return { mean: snap.mean, se: snap.meanSe, complete: snap.complete, deterministic: snap.deterministic };
      }),
    );
  });

  const colMeans = $derived(axes.columns.map((_, c) => meanOf(means.map((row) => row[c]?.mean ?? NaN))));
  const rowMeans = $derived(means.map((row) => meanOf(row.map((m) => m?.mean ?? NaN))));
  const colDone = $derived(axes.columns.map((_, c) => means.every((row) => row[c]?.complete)));
  const rowDone = $derived(means.map((row) => row.every((m) => m?.complete)));

  function cellText(m: MeanCell | null): string {
    if (!m) return 'waiting';
    return fmtMean(m.mean, m.deterministic ? null : m.se, !m.complete);
  }

  function opener(o: string | null): string {
    return o ? o.toUpperCase() : "strategy's choice";
  }

  // Header geometry (screen px).
  const HEADER_H = 46;
  const colStyle = (c: number): string => {
    const s = sceneView.s;
    const x = sceneView.tx + c * layout.pitchX * s + (drag?.kind === 'col' && drag.index === c ? drag.dx : 0);
    const y = sceneView.ty - HEADER_H - 8;
    return `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${headW.toFixed(1)}px;height:${HEADER_H}px;opacity:${headerAlpha.toFixed(3)}`;
  };
  const ROW_W = 140;
  const rowStyle = (r: number): string => {
    const s = sceneView.s;
    const x = sceneView.tx - ROW_W - 10;
    const y = sceneView.ty + r * layout.pitchY * s + (drag?.kind === 'row' && drag.index === r ? drag.dy : 0);
    return `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${ROW_W}px;height:${Math.max(44, CARD_H * s).toFixed(1)}px;opacity:${headerAlpha.toFixed(3)}`;
  };
  /**
   * Header width on screen decides what a column header shows: the name with
   * a "Rank openers" button, the name with an icon button, the name alone
   * (ranking stays in the header menu), or just the swatch. Narrow headers
   * borrow the gap to the next column.
   */
  const colW = $derived(CARD_W * sceneView.s);
  const headW = $derived(colW >= 170 ? colW : Math.max(colW, layout.pitchX * sceneView.s - 6));
  const wide = $derived(headW >= 300);
  const narrow = $derived(headW < 170);
  const showRank = $derived(headW >= 150);
  const tiny = $derived(headW < 70);
  const short = $derived(CARD_H * sceneView.s < 110);

  // Dragging headers to reorder columns and rows.
  let drag = $state<{ kind: 'col' | 'row'; index: number; x0: number; y0: number; dx: number; dy: number; moved: boolean } | null>(null);

  function dragStart(e: PointerEvent, kind: 'col' | 'row', index: number): void {
    if (e.button !== 0) return;
    drag = { kind, index, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function dragMove(e: PointerEvent): void {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    if (drag.kind === 'col') drag.dx = dx;
    else drag.dy = dy;
  }

  function dragEnd(e: PointerEvent): boolean {
    const d = drag;
    drag = null;
    if (!d || !d.moved) return false;
    e.preventDefault();
    const s = sceneView.s || 1;
    if (d.kind === 'col') moveColumn(d.index, dropIndex(d.index, d.dx / s, layout.pitchX, axes.columns.length));
    else moveRow(d.index, dropIndex(d.index, d.dy / s, layout.pitchY, axes.rows.length));
    return true;
  }

  function seeded(): void {
    if (!app.atlas.columns.length) app.atlas.columns = [...axes.columns];
    if (!app.atlas.rows.length) app.atlas.rows = [...axes.rows];
  }

  function moveColumn(from: number, to: number): void {
    if (from === to) return;
    seeded();
    app.atlas.columns = moveItem(app.atlas.columns, from, to);
    app.atlas.selected = [];
  }

  function moveRow(from: number, to: number): void {
    if (from === to) return;
    seeded();
    app.atlas.rows = moveItem(app.atlas.rows, from, to);
    app.atlas.selected = [];
  }

  function sortOpeners(c: number): void {
    seeded();
    const s = axes.columns[c];
    if (!s) return;
    const ms = app.atlas.rows.map((o) => {
      const snap = cells.peek(s.id, o)?.snapshot;
      return snap && snap.nGames > 0 ? snap.mean : NaN;
    });
    app.atlas.rows = sortByMean(app.atlas.rows, ms);
    app.atlas.selected = [];
  }

  // Header menus.
  let headerMenu = $state<{ kind: 'col' | 'row'; index: number; x: number; y: number } | null>(null);
  let menuEl = $state<HTMLElement | null>(null);

  function openHeaderMenu(e: MouseEvent, kind: 'col' | 'row', index: number): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    headerMenu = { kind, index, x: kind === 'col' ? r.left : r.right + 4, y: kind === 'col' ? r.bottom + 4 : r.top };
    void tick().then(() => menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  }

  function gripClick(e: MouseEvent, kind: 'col' | 'row', index: number): void {
    // A drag ends in a click too; only a plain click opens the menu.
    if (dragJustEnded) {
      dragJustEnded = false;
      return;
    }
    openHeaderMenu(e, kind, index);
  }
  let dragJustEnded = false;
  function gripUp(e: PointerEvent): void {
    dragJustEnded = dragEnd(e);
  }

  function menuAct(fn: () => void): void {
    headerMenu = null;
    try {
      fn();
    } catch (err) {
      console.warn('[atlas menu]', err);
    }
  }

  function menuKey(e: KeyboardEvent): void {
    const items = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      headerMenu = null;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') headerMenu = null;
  }

  function outside(e: PointerEvent): void {
    if (headerMenu && menuEl && e.target instanceof Node && !menuEl.contains(e.target)) headerMenu = null;
  }

  function menuStyle(m: { x: number; y: number }): string {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    return `left:${Math.max(8, Math.min(m.x, vw - 248))}px;top:${Math.max(8, Math.min(m.y, vh - 300))}px`;
  }

  // Rankings and compare.
  function rankOpenersFor(c: number): void {
    const s = axes.columns[c];
    if (s) app.ui.rankingFor = { kind: 'column', strategy: s.id };
  }
  function rankStrategiesFor(r: number): void {
    const o = axes.rows[r];
    if (o !== undefined) app.ui.rankingFor = { kind: 'row', opener: o };
  }
  const rankingKey = $derived(app.ui.rankingFor ? JSON.stringify(app.ui.rankingFor) : '');
  const showCompare = $derived(app.ui.compare && app.atlas.selected.length === 2 && sceneView.visible);

  function closeCompare(): void {
    app.ui.compare = false;
    app.atlas.selected = [];
  }

  function toggleCompare(): void {
    cardUi.compareMode = !cardUi.compareMode;
    if (!cardUi.compareMode && app.atlas.selected.length < 2) app.atlas.selected = [];
  }

  function openCardMenu(e: MouseEvent): void {
    const f = sceneView.focus;
    if (!f) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    cardUi.menu = { x: r.left, y: Math.max(8, r.top - 310), col: f[0], row: f[1] };
  }

  const toolbarStyle = $derived(`left:${sceneView.vp.left + 12}px;top:${sceneView.vp.top + sceneView.vp.height - 56}px`);

  // Esc closes the innermost card/atlas menu or panel before the platform's Esc zooms out.
  function closeInnermost(): boolean {
    if (headerMenu) headerMenu = null;
    else if (cardUi.menu) cardUi.menu = null;
    else if (app.ui.rankingFor) app.ui.rankingFor = null;
    else if (showCompare) closeCompare();
    else if (cardUi.table && sceneView.visible) cardUi.table = false;
    else return false;
    return true;
  }
  $effect(() =>
    registerShortcut({
      keys: ['Escape'],
      description: 'Close a card menu or panel',
      when: () => !!(headerMenu || cardUi.menu || app.ui.rankingFor || showCompare || (cardUi.table && sceneView.visible)),
      handler: () => void closeInnermost(),
    }),
  );
</script>

<svelte:window onpointerdown={outside} />

{#if shown}
  <div class="toolbar" role="toolbar" aria-label="Card and atlas tools" style={toolbarStyle}>
    <button aria-pressed={cardUi.table} onclick={() => (cardUi.table = !cardUi.table)} title="Show the data as a table">Table</button>
    <button aria-pressed={cardUi.compareMode} onclick={toggleCompare} title="Tap two cards to compare them (or shift-click)">
      Compare{#if app.atlas.selected.length} ({app.atlas.selected.length}/2){/if}
    </button>
    {#if atAtlas && multi}
      <button aria-pressed={cardUi.margins} onclick={() => (cardUi.margins = !cardUi.margins)} title="Show each row's and column's mean">Margins</button>
    {/if}
    {#if level === 2 && sceneView.focus}
      <button onclick={openCardMenu} aria-haspopup="menu" title="Card actions">Card…</button>
    {/if}
    {#if atAtlas}
      <button onclick={() => openExport('atlas')} title="Export the atlas as CSV">Export…</button>
    {/if}
  </div>
{/if}

{#if sceneView.visible && headerAlpha > 0.02}
  <div class="headers" inert={headerAlpha < 0.5}>
    {#each axes.columns as s, c (s.id)}
      <div class="col-head" class:narrow class:tiny class:margins={cardUi.margins && multi} class:dragging={drag?.kind === 'col' && drag.index === c} style={colStyle(c)}>
        <button
          class="grip"
          aria-haspopup="menu"
          aria-label="{s.label}{cardUi.margins && multi ? `, column mean ${fmtMean(colMeans[c], null, !colDone[c])}` : ''}: column options (drag to move)"
          title={s.label}
          onpointerdown={(e) => dragStart(e, 'col', c)}
          onpointermove={dragMove}
          onpointerup={gripUp}
          onpointercancel={() => (drag = null)}
          onclick={(e) => gripClick(e, 'col', c)}
        >
          <span class="swatch" style="background:{s.colour}" aria-hidden="true"></span>
          <span class="lines">
            {#if !(tiny && cardUi.margins && multi)}<span class="name">{s.label}</span>{/if}
            {#if cardUi.margins && multi}
              <span class="margin">{tiny ? '' : 'mean '}{fmtMean(colMeans[c], null, !colDone[c])}</span>
            {/if}
          </span>
        </button>
        {#if showRank}
          <button class="rank" class:icon={!wide} onclick={() => rankOpenersFor(c)} title="Rank openers under {s.label}" aria-label="Rank openers under {s.label}">
            {#if wide}Rank openers{:else}<span aria-hidden="true">⇅</span>{/if}
          </button>
        {/if}
      </div>
    {/each}
    {#each axes.rows as o, r (o ?? '∅')}
      <div class="row-head" class:short class:dragging={drag?.kind === 'row' && drag.index === r} style={rowStyle(r)}>
        <button
          class="grip"
          aria-haspopup="menu"
          aria-label="Opener {opener(o)}: row options (drag to move)"
          onpointerdown={(e) => dragStart(e, 'row', r)}
          onpointermove={dragMove}
          onpointerup={gripUp}
          onpointercancel={() => (drag = null)}
          onclick={(e) => gripClick(e, 'row', r)}
        >
          <span class="word" class:choice={!o}>{opener(o)}</span>
          {#if cardUi.margins && multi}
            <span class="margin">{fmtMean(rowMeans[r], null, !rowDone[r])}</span>
          {/if}
        </button>
        <button class="rank" class:icon={short} onclick={() => rankStrategiesFor(r)} title="Rank strategies for {opener(o)}" aria-label="Rank strategies for opener {opener(o)}">
          {#if short}<span aria-hidden="true">⇅</span>{:else}Rank strategies{/if}
        </button>
      </div>
    {/each}
  </div>
{/if}

{#if headerMenu}
  <div class="menu" role="menu" tabindex="-1" style={menuStyle(headerMenu)} bind:this={menuEl} onkeydown={menuKey}>
    {#if headerMenu.kind === 'col'}
      {@const c = headerMenu.index}
      <button role="menuitem" onclick={() => menuAct(() => rankOpenersFor(c))}>Rank openers</button>
      <button role="menuitem" disabled={axes.rows.length < 2} onclick={() => menuAct(() => sortOpeners(c))}>Sort openers by mean</button>
      <button role="menuitem" disabled={c === 0} onclick={() => menuAct(() => moveColumn(c, c - 1))}>Move left</button>
      <button role="menuitem" disabled={c >= axes.columns.length - 1} onclick={() => menuAct(() => moveColumn(c, c + 1))}>Move right</button>
      <button role="menuitem" disabled={axes.columns.length < 2} onclick={() => menuAct(() => removeColumn(c))}>Remove column</button>
    {:else}
      {@const r = headerMenu.index}
      <button role="menuitem" onclick={() => menuAct(() => rankStrategiesFor(r))}>Rank strategies</button>
      <button role="menuitem" disabled={r === 0} onclick={() => menuAct(() => moveRow(r, r - 1))}>Move up</button>
      <button role="menuitem" disabled={r >= axes.rows.length - 1} onclick={() => menuAct(() => moveRow(r, r + 1))}>Move down</button>
      <button role="menuitem" disabled={axes.rows.length < 2} onclick={() => menuAct(() => removeRow(r))}>Remove row</button>
    {/if}
  </div>
{/if}

{#if atAtlas}
  <section
    class="means"
    class:visually-hidden={!cardUi.table}
    aria-label="Atlas table of means"
    style={cardUi.table ? `left:${sceneView.vp.left + 12}px;top:${sceneView.vp.top + 12}px` : ''}
  >
    {#if cardUi.table}
      <button class="close" onclick={() => (cardUi.table = false)} aria-label="Hide the table">×</button>
    {/if}
    <table>
      <caption>Mean guesses by opener (rows) and strategy (columns); ~ marks estimates still filling.</caption>
      <thead>
        <tr>
          <th scope="col">Opener</th>
          {#each axes.columns as s (s.id)}<th scope="col">{s.label}</th>{/each}
          {#if multi}<th scope="col">Row mean</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each axes.rows as o, r (o ?? '∅')}
          <tr>
            <th scope="row" class="word">{opener(o)}</th>
            {#each axes.columns as s, c (s.id)}<td class="num">{cellText(means[r]?.[c] ?? null)}</td>{/each}
            {#if multi}<td class="num">{fmtMean(rowMeans[r], null, !rowDone[r])}</td>{/if}
          </tr>
        {/each}
      </tbody>
      {#if multi}
        <tfoot>
          <tr>
            <th scope="row">Column mean</th>
            {#each axes.columns as s, c (s.id)}<td class="num">{fmtMean(colMeans[c], null, !colDone[c])}</td>{/each}
            <td></td>
          </tr>
        </tfoot>
      {/if}
    </table>
  </section>
{/if}

{#if app.ui.rankingFor && sceneView.visible}
  {#key rankingKey}
    <RankingPanel request={app.ui.rankingFor} onclose={() => (app.ui.rankingFor = null)} />
  {/key}
{/if}

{#if showCompare}
  <ComparePanel onclose={closeCompare} />
{/if}

<style>
  .toolbar {
    position: fixed;
    z-index: 9;
    display: flex;
    gap: 6px;
    padding: 4px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    border: 1px solid var(--line);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.1);
  }
  .toolbar button {
    min-height: 44px;
    min-width: 44px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }
  .toolbar button:hover {
    background: var(--panel);
  }
  .toolbar button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .headers {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 7;
  }
  .col-head,
  .row-head {
    position: absolute;
    display: flex;
    pointer-events: auto;
    box-sizing: border-box;
    gap: 4px;
  }
  .col-head {
    align-items: stretch;
  }
  .row-head {
    flex-direction: column;
    justify-content: center;
    align-items: stretch;
  }
  .row-head.short {
    flex-direction: row;
    align-items: center;
  }
  .dragging {
    z-index: 2;
    filter: drop-shadow(0 6px 12px rgb(0 0 0 / 0.2));
  }
  .grip {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    color: var(--fg);
    cursor: grab;
    touch-action: none;
    text-align: left;
  }
  .row-head .grip {
    flex: none;
    flex-wrap: wrap;
    justify-content: flex-end;
    text-align: right;
  }
  .row-head.short .grip {
    flex: 1;
  }
  .grip:active {
    cursor: grabbing;
  }
  .swatch {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  .lines {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: 13px;
  }
  .col-head .name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .col-head.margins .name {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .narrow .name {
    font-size: 11.5px;
  }
  .col-head .margin {
    margin-left: 0;
    font-size: 11.5px;
  }
  .col-head.tiny .grip {
    padding: 0 4px;
    gap: 3px;
    justify-content: center;
  }
  .col-head.tiny .swatch {
    width: 9px;
    height: 9px;
  }
  .col-head.tiny .lines {
    flex: none;
  }
  .col-head.tiny .name {
    display: none;
  }
  .rank.icon {
    width: 44px;
    padding: 0;
    font-size: 16px;
  }
  .word {
    font-family: var(--font-mono);
    font-weight: 650;
    letter-spacing: 0.06em;
    font-size: 14px;
  }
  .word.choice {
    font-family: var(--font-sans);
    font-weight: 500;
    letter-spacing: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .margin {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .row-head .margin {
    margin-left: 0;
    width: 100%;
  }
  .rank {
    flex: none;
    min-height: 44px;
    min-width: 44px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    color: var(--fg);
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }
  .rank:hover,
  .grip:hover {
    border-color: var(--accent);
  }
  .menu {
    position: fixed;
    z-index: 40;
    min-width: 200px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 10px 34px rgb(0 0 0 / 0.22);
    padding: 6px;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0 12px;
    min-height: 40px;
    border-radius: 6px;
    cursor: pointer;
  }
  .menu button:hover:not(:disabled),
  .menu button:focus-visible {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    outline: none;
  }
  .menu button:disabled {
    color: var(--muted);
    opacity: 0.6;
    cursor: default;
  }
  .means {
    position: fixed;
    z-index: 12;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 24px);
    overflow: auto;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 14px;
    box-shadow: 0 8px 30px rgb(0 0 0 / 0.18);
    font-size: 13px;
  }
  .close {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 44px;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 22px;
    cursor: pointer;
  }
  table {
    border-collapse: collapse;
  }
  caption {
    text-align: left;
    padding: 0 40px 8px 0;
    color: var(--muted);
    font-size: 12px;
  }
  th,
  td {
    padding: 3px 8px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-weight: 400;
  }
  thead th {
    font-weight: 600;
    font-size: 12px;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
