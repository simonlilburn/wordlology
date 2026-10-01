<script lang="ts">
  // Owned by the card/atlas agent: DOM overlays at card and atlas zoom — the
  // card's distribution table (the Level 2 text alternative; visually hidden
  // unless the Table toggle is on), the dashed "+ Strategy" / "+ Opener"
  // cards, and the card context menu (long press / right-click).
  import { tick } from 'svelte';
  import { app } from '../../app/store.svelte';
  import { openExport } from '../../export';
  import { cells, gridAxes } from '../../scene/atlas/cells';
  import {
    addOpener,
    addStrategy,
    focusCell,
    openSearch,
    removeColumn,
    removeRow,
    toggleSelect,
  } from '../../scene/atlas/interact';
  import { CARD_H, CARD_W, gridLayout, type Rect } from '../../scene/atlas/layout';
  import { cardUi, sceneView } from '../../scene/atlas/view.svelte';
  import { summarise, type CardSummary } from './summary';

  const level = $derived(Math.round(app.zDragging ? app.z : app.zTarget));
  const atCard = $derived(sceneView.visible && level === 2);

  interface FocusCard {
    label: string;
    colour: string;
    opener: string | null;
    sampling: string;
    hard: boolean;
    listName: string;
    summary: CardSummary | null;
    error: string | null;
  }

  const card = $derived.by((): FocusCard | null => {
    void sceneView.tick;
    void app.result.maxGuesses;
    if (!atCard) return null;
    const s = app.focus.strategy;
    if (!s) return null;
    const cell = cells.peek(s.id, app.focus.opener) ?? cells.focus();
    if (!cell) return null;
    const snap = cell.snapshot;
    return {
      label: s.label,
      colour: s.colour,
      opener: app.focus.opener,
      sampling: cell.deterministic ? 'exact' : `sampled, R = ${cell.replicates}`,
      hard: cell.config?.rules.hard_mode ?? app.result.hardMode,
      listName: app.words?.manifest.name ?? 'word list',
      summary: snap && snap.nGames > 0 ? summarise(snap, cell.replicates) : null,
      error: cell.error,
    };
  });

  // Dashed cards: positioned from the scene's layout → screen transform.
  const dashed = $derived.by(() => {
    const cols = sceneView.cols, rows = sceneView.rows;
    const g = gridLayout(cols, rows);
    return { col: g.dashedCol, row: g.dashedRow };
  });
  const dashedAlpha = $derived(sceneView.visible ? sceneView.dashedAlpha : 0);

  // A ring around the focused card in the Atlas (where the camera goes on zooming in).
  const focusRing = $derived.by(() => {
    const f = sceneView.focus;
    if (!f || !sceneView.visible || !sceneView.grid || sceneView.headerAlpha < 0.02) return null;
    const g = gridLayout(sceneView.cols, sceneView.rows);
    const s = sceneView.s;
    const pad = 5;
    const x = sceneView.tx + f[0] * g.pitchX * s - pad, y = sceneView.ty + f[1] * g.pitchY * s - pad;
    return `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${(CARD_W * s + 2 * pad).toFixed(1)}px;height:${(CARD_H * s + 2 * pad).toFixed(1)}px;opacity:${sceneView.headerAlpha.toFixed(3)}`;
  });

  function rectStyle(r: Rect, alpha: number): string {
    const s = sceneView.s;
    const x = sceneView.tx + r.x * s, y = sceneView.ty + r.y * s;
    const fs = Math.max(11, Math.min(22, 18 * s));
    return `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${(r.w * s).toFixed(1)}px;height:${(r.h * s).toFixed(1)}px;opacity:${alpha.toFixed(3)};font-size:${fs.toFixed(1)}px`;
  }

  // Context menu (cardUi.menu), shared with the scene's long press / right-click.
  let menuEl = $state<HTMLElement | null>(null);
  const menu = $derived(cardUi.menu);
  const menuCell = $derived.by(() => {
    const m = cardUi.menu;
    if (!m) return null;
    const { columns, rows } = gridAxes();
    const s = columns[m.col], o = rows[m.row];
    if (!s || o === undefined) return null;
    return { strategy: s, opener: o, nCols: columns.length, nRows: rows.length, col: m.col, row: m.row };
  });
  const menuSelected = $derived(!!menu && app.atlas.selected.some(([c, r]) => c === menu.col && r === menu.row));

  $effect(() => {
    if (menu && menuEl) {
      void tick().then(() => menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    }
  });

  function closeMenu(): void {
    cardUi.menu = null;
  }

  function act(fn: () => void): void {
    // Act before closing: the items read the menu's cell.
    if (menuCell) {
      try {
        fn();
      } catch (e) {
        console.warn('[card menu]', e);
      }
    }
    closeMenu();
  }

  const menuStyle = $derived.by(() => {
    const m = menu;
    if (!m) return '';
    const W = 240, H = 300;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const x = Math.max(8, Math.min(m.x, vw - W - 8));
    const y = Math.max(8, Math.min(m.y, vh - H - 8));
    return `left:${x}px;top:${y}px`;
  });

  function menuKey(e: KeyboardEvent): void {
    const items = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  }

  function outside(e: PointerEvent): void {
    if (!cardUi.menu) return;
    if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
    // Let the scene's own click handling close it when the press lands on the canvas.
    if (e.target instanceof HTMLCanvasElement) return;
    closeMenu();
  }

  function opener(o: string | null): string {
    return o ? o.toUpperCase() : "strategy's choice";
  }
</script>

<svelte:window onpointerdown={outside} />

{#if focusRing}
  <div class="focus-ring" style={focusRing} aria-hidden="true"></div>
{/if}

{#if sceneView.visible && dashedAlpha > 0.02}
  <div class="dashed-layer" inert={dashedAlpha < 0.5}>
    <button
      class="dashed"
      style={rectStyle(dashed.col, dashedAlpha)}
      onclick={() => addStrategy()}
      title="Add a strategy column (opens the Strategy Lab)"
    >
      <span class="plus" aria-hidden="true">+</span><span>Strategy</span>
    </button>
    <button
      class="dashed"
      style={rectStyle(dashed.row, dashedAlpha)}
      onclick={() => addOpener()}
      title="Add an opener row (opens the opener picker)"
    >
      <span class="plus" aria-hidden="true">+</span><span>Opener</span>
    </button>
  </div>
{/if}

{#if card}
  <!-- A labelled scroll region: focusable so keyboard users can scroll it (WCAG 2.1.1). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <section
    class="card-table"
    class:visually-hidden={!cardUi.table}
    aria-label="Card distribution table"
    tabindex={cardUi.table ? 0 : undefined}
    style={cardUi.table ? `left:${sceneView.vp.left + 12}px;top:${sceneView.vp.top + 12}px` : ''}
  >
    {#if cardUi.table}
      <button class="close" onclick={() => (cardUi.table = false)} aria-label="Hide the table">×</button>
    {/if}
    <table>
      <caption>
        <span class="swatch" style="background:{card.colour}" aria-hidden="true"></span>
        <strong>{card.label}</strong>, opener <span class="word">{opener(card.opener)}</span>
        <span class="sub">
          {card.listName} · {card.sampling}{card.hard ? ' · hard mode' : ''}
          {#if card.summary} · {card.summary.status}{/if}
        </span>
      </caption>
      {#if card.summary}
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col" class="num">Games</th>
            <th scope="col" class="num">Share</th>
            {#if card.summary.rows.some((r) => r.interval)}<th scope="col" class="num">95% interval</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each card.summary.rows as r (r.name)}
            <tr>
              <th scope="row">{r.name}</th>
              <td class="num">{r.count}</td>
              <td class="num">
                <span class="bar" style="width:{Math.round(r.value * 60)}px" aria-hidden="true"></span>{r.share}
              </td>
              {#if card.summary.rows.some((x) => x.interval)}<td class="num">{r.interval ?? ''}</td>{/if}
            </tr>
          {/each}
        </tbody>
        <tfoot>
          {#if card.summary.unresolved}
            <tr><th scope="row">Unresolved</th><td colspan="3">{card.summary.unresolved}</td></tr>
          {/if}
          <tr><th scope="row">Mean guesses</th><td colspan="3">{card.summary.mean}</td></tr>
          <tr><th scope="row">Solved</th><td colspan="3">{card.summary.solved}</td></tr>
          <tr><th scope="row">95th percentile</th><td colspan="3">{card.summary.p95}</td></tr>
        </tfoot>
      {:else}
        <tbody><tr><td>{card.error ?? 'Waiting for the first games…'}</td></tr></tbody>
      {/if}
    </table>
  </section>
{/if}

{#if menu && menuCell}
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label="Card actions: {menuCell.strategy.label}, {opener(menuCell.opener)}"
    style={menuStyle}
    bind:this={menuEl}
    onkeydown={menuKey}
  >
    <div class="menu-title">
      <span class="swatch" style="background:{menuCell.strategy.colour}" aria-hidden="true"></span>
      {menuCell.strategy.label} · <span class="word">{opener(menuCell.opener)}</span>
    </div>
    <button role="menuitem" onclick={() => act(() => { focusCell(menuCell.col, menuCell.row); openSearch(); })}>Find a target…</button>
    <button role="menuitem" onclick={() => act(() => { focusCell(menuCell.col, menuCell.row); openExport('card'); })}>Export card…</button>
    <button role="menuitem" onclick={() => act(() => { focusCell(menuCell.col, menuCell.row); addOpener(); })}>Duplicate with another opener…</button>
    <button role="menuitem" onclick={() => act(() => { focusCell(menuCell.col, menuCell.row); app.ui.lab = true; })}>Edit strategy…</button>
    <button role="menuitem" onclick={() => act(() => toggleSelect(menuCell.col, menuCell.row))}>
      {menuSelected ? 'Deselect for compare' : 'Select for compare'}
    </button>
    <button role="menuitem" disabled={menuCell.nCols <= 1} onclick={() => act(() => removeColumn(menuCell.col))}>Remove strategy column</button>
    <button role="menuitem" disabled={menuCell.nRows <= 1} onclick={() => act(() => removeRow(menuCell.row))}>Remove opener row</button>
  </div>
{/if}

<style>
  .focus-ring {
    position: fixed;
    z-index: 5;
    pointer-events: none;
    box-sizing: border-box;
    border: 2px solid var(--accent);
    border-radius: 16px;
  }
  .dashed-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 6;
  }
  .dashed {
    position: absolute;
    box-sizing: border-box;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2em;
    border: 2px dashed color-mix(in srgb, var(--muted) 70%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--panel) 55%, transparent);
    color: var(--muted);
    cursor: pointer;
    min-width: 44px;
    min-height: 44px;
    padding: 4px;
    transition: background 120ms, color 120ms, border-color 120ms;
  }
  .dashed:hover,
  .dashed:focus-visible {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--panel));
    outline: none;
  }
  .dashed-layer[inert] .dashed {
    pointer-events: none;
  }
  .plus {
    font-size: 1.8em;
    line-height: 1;
    font-weight: 300;
  }
  /* Hidden from view (still read by screen readers): clipped, not a scroll area. */
  .card-table.visually-hidden {
    overflow: hidden;
  }
  .card-table:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
  }
  .card-table {
    position: fixed;
    z-index: 12;
    max-width: min(360px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    overflow: auto;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
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
    width: 100%;
  }
  caption {
    text-align: left;
    padding: 0 40px 8px 0;
    line-height: 1.4;
  }
  .sub {
    display: block;
    color: var(--muted);
    font-size: 12px;
  }
  th,
  td {
    padding: 3px 6px;
    text-align: left;
    border-bottom: 1px solid var(--line);
    font-weight: 400;
  }
  thead th {
    font-weight: 600;
    color: var(--muted);
    font-size: 12px;
  }
  tbody th,
  tfoot th {
    font-weight: 500;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bar {
    display: inline-block;
    height: 6px;
    margin-right: 6px;
    vertical-align: middle;
    background: var(--fg);
    opacity: 0.7;
    border-radius: 1px;
  }
  .swatch {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: baseline;
  }
  .word {
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }
  .menu {
    position: fixed;
    z-index: 40;
    min-width: 220px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: 0 10px 34px rgb(0 0 0 / 0.22);
    padding: 6px;
    display: flex;
    flex-direction: column;
  }
  .menu-title {
    font-size: 12px;
    color: var(--muted);
    padding: 6px 10px 8px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 4px;
  }
  .menu button {
    text-align: left;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0 12px;
    min-height: 44px;
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
</style>
