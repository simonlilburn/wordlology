<script lang="ts">
  // Owned by the panes agent: side pane (desktop, right) / bottom sheet (phones).
  // Visible at the Tree, Card and Atlas levels (z ≥ ~0.5), hidden on the Game board.
  import { onMount, tick } from 'svelte';
  import { registerShortcut } from '../app/keyboard';
  import { app } from '../app/store.svelte';
  import { copyRCode, openExport, type ExportLevel } from '../export/index';
  import { filterActive } from '../model/filter';
  import FilterBuilder from './filter/FilterBuilder.svelte';
  import { startLive } from './live.svelte';
  import { deterministic, focusedSpec, labelOf } from './services';
  import Legend from './side/Legend.svelte';
  import LevelButtons from './side/LevelButtons.svelte';
  import OpenerField from './side/OpenerField.svelte';
  import PathReadout from './side/PathReadout.svelte';
  import Replicates from './side/Replicates.svelte';
  import StrategyPicker from './side/StrategyPicker.svelte';
  import { paneState, type SheetState } from './state.svelte';
  import { clamp } from './util';
  import Wordmark from '../app/Wordmark.svelte';

  const PANE_WIDTH = 340;
  const COLLAPSED_H = 72;
  /** Phones: the bar at the foot of the sheet. */
  const BAR_H = 56;

  let openerInput = $state<HTMLInputElement | null>(null);
  let filterText = $state<HTMLInputElement | null>(null);
  let paneEl = $state<HTMLElement | null>(null);
  let viewportH = $state(typeof window !== 'undefined' ? window.innerHeight : 800);

  /** 0 on the Game board, 1 from z ≈ 0.7 upward. */
  const opacity = $derived(clamp((app.z - 0.3) / 0.4, 0, 1));
  const shown = $derived(opacity > 0.02);
  const level = $derived(Math.round(app.zTarget));

  // The collapsed sheet keeps its handle and the bar at its foot.
  const heights = $derived({ collapsed: COLLAPSED_H + BAR_H, half: Math.round(viewportH * 0.46), full: Math.max(COLLAPSED_H + BAR_H, viewportH - 56) });
  let dragH = $state<number | null>(null);
  const sheetH = $derived(dragH ?? heights[paneState.sheet]);

  const strategyLabel = $derived(app.focus.strategy?.label ?? labelOf(focusedSpec()));
  const stochastic = $derived(!deterministic(focusedSpec()));
  const filterOn = $derived(filterActive(app.filter));

  // Publish the covered area for the scene.
  $effect(() => {
    const occ = paneState.occluded;
    if (!shown) {
      occ.right = 0;
      occ.bottom = 0;
    } else if (paneState.phone) {
      occ.right = 0;
      occ.bottom = sheetH;
    } else {
      occ.right = app.ui.paneOpen ? PANE_WIDTH : 0;
      occ.bottom = 0;
    }
  });

  function notGame() {
    return app.z >= 0.5 || app.zTarget >= 0.5;
  }

  async function reveal(): Promise<void> {
    app.ui.paneOpen = true;
    if (paneState.phone && paneState.sheet === 'collapsed') paneState.sheet = 'half';
    await tick();
  }

  async function focusStrategy() {
    await reveal();
    const list = paneEl?.querySelector('[data-strategy-list]');
    const btn = (list?.querySelector('button[aria-pressed="true"]') ?? list?.querySelector('button:not(:disabled)')) as HTMLButtonElement | null;
    btn?.scrollIntoView?.({ block: 'nearest' });
    btn?.focus();
  }

  async function focusOpener() {
    await reveal();
    openerInput?.scrollIntoView?.({ block: 'nearest' });
    openerInput?.focus();
  }

  async function toggleFilter(force?: boolean) {
    const open = force ?? !paneState.filterOpen;
    paneState.filterOpen = open;
    if (!open) return;
    await reveal();
    if (paneState.phone) paneState.sheet = 'full';
    await tick();
    filterText?.scrollIntoView?.({ block: 'nearest' });
    filterText?.focus();
  }

  function exportLevel(): ExportLevel {
    return level >= 3 ? 'atlas' : level === 2 ? 'card' : 'tree';
  }

  function doExport() {
    try {
      openExport(exportLevel());
    } catch {
      /* platform not ready */
    }
  }

  async function doCopyR() {
    try {
      await copyRCode();
    } catch {
      /* platform not ready */
    }
  }

  // Bottom sheet dragging.
  let dragStartY = 0;
  let dragStartH = 0;
  let dragMoved = false;
  let dragging = false;

  function onHandleDown(e: PointerEvent) {
    dragging = true;
    dragMoved = false;
    dragStartY = e.clientY;
    dragStartH = sheetH;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onHandleMove(e: PointerEvent) {
    if (!dragging) return;
    const dy = dragStartY - e.clientY;
    if (Math.abs(dy) > 6) dragMoved = true;
    if (dragMoved) dragH = clamp(dragStartH + dy, heights.collapsed, heights.full);
  }

  function onHandleUp() {
    if (!dragging) return;
    dragging = false;
    if (dragMoved && dragH !== null) {
      const h = dragH;
      const states: SheetState[] = ['collapsed', 'half', 'full'];
      let best: SheetState = 'half';
      let bestD = Infinity;
      for (const s of states) {
        const d = Math.abs(heights[s] - h);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      paneState.sheet = best;
    }
    dragH = null;
  }

  function onHandleClick() {
    if (dragMoved) return;
    paneState.sheet = paneState.sheet === 'collapsed' ? 'half' : paneState.sheet === 'half' ? 'full' : 'collapsed';
  }

  function onHandleKey(e: KeyboardEvent) {
    const order: SheetState[] = ['collapsed', 'half', 'full'];
    const i = order.indexOf(paneState.sheet);
    if (e.key === 'ArrowUp') paneState.sheet = order[Math.min(2, i + 1)];
    else if (e.key === 'ArrowDown') paneState.sheet = order[Math.max(0, i - 1)];
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  onMount(() => {
    startLive();
    const mq = window.matchMedia('(max-width: 720px)');
    const onMq = () => (paneState.phone = mq.matches);
    onMq();
    mq.addEventListener('change', onMq);
    const onResize = () => (viewportH = window.innerHeight);
    window.addEventListener('resize', onResize);
    const offs = [
      registerShortcut({ keys: ['s', 'S'], description: 'Strategy', when: notGame, handler: () => void focusStrategy() }),
      registerShortcut({ keys: ['o', 'O'], description: 'Opener', when: notGame, handler: () => void focusOpener() }),
      registerShortcut({ keys: ['f', 'F'], description: 'Letter filter', when: notGame, handler: () => void toggleFilter() }),
      registerShortcut({ keys: ['/'], description: 'Target search', when: notGame, handler: () => (app.ui.search = true) }),
    ];
    return () => {
      mq.removeEventListener('change', onMq);
      window.removeEventListener('resize', onResize);
      for (const off of offs) off();
    };
  });
</script>

{#if !paneState.phone && !app.ui.paneOpen && shown}
  <button type="button" class="reopen" style:opacity onclick={() => (app.ui.paneOpen = true)} aria-label="Show side pane">
    <span aria-hidden="true">☰</span>
  </button>
{/if}

<aside
  bind:this={paneEl}
  data-side-pane
  data-covers={!shown ? 'none' : paneState.phone ? 'bottom' : app.ui.paneOpen ? 'right' : 'none'}
  class="pane"
  class:phone={paneState.phone}
  class:closed={!paneState.phone && !app.ui.paneOpen}
  class:hidden={!shown}
  class:dragging={dragH !== null}
  style:opacity
  style:--pane-w="{PANE_WIDTH}px"
  style:height={paneState.phone ? `${sheetH}px` : undefined}
  aria-label="Controls"
  inert={!shown || (!paneState.phone && !app.ui.paneOpen)}
>
  {#if paneState.phone}
    <button
      type="button"
      class="handle"
      aria-label="Resize controls sheet ({paneState.sheet})"
      aria-expanded={paneState.sheet !== 'collapsed'}
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleUp}
      onclick={onHandleClick}
      onkeydown={onHandleKey}
    >
      <span class="grip" aria-hidden="true"></span>
      <span class="summary">
        <span class="swatch" style:background={app.focus.strategy?.colour ?? 'var(--accent)'} aria-hidden="true"></span>
        {strategyLabel} · {app.focus.opener ? app.focus.opener.toUpperCase() : "strategy's choice"}
        {#if filterOn}<span class="dot" title="Filter on" aria-label="filter on"></span>{/if}
      </span>
    </button>
  {/if}

  <div class="scroll">
    {#if !paneState.phone}{@render bar()}{/if}

    <LevelButtons />

    <PathReadout />

    <section aria-labelledby="pane-strategy">
      <h3 id="pane-strategy">Strategy <kbd>S</kbd></h3>
      <StrategyPicker />
    </section>

    <section aria-labelledby="pane-opener">
      <h3 id="pane-opener">Opener <kbd>O</kbd></h3>
      <OpenerField bind:inputEl={openerInput} />
    </section>

    <section aria-labelledby="pane-reps">
      <h3 id="pane-reps">Replicates{stochastic ? ' R' : ''}</h3>
      <Replicates />
    </section>

    <section aria-labelledby="pane-filter">
      <h3 id="pane-filter" class="visually-hidden">Letter filter</h3>
      <button
        type="button"
        class="filterbtn kc"
        class:on={filterOn}
        aria-expanded={paneState.filterOpen}
        aria-controls="pane-filter-builder"
        onclick={() => toggleFilter()}
      >
        <span class="accent" aria-hidden="true"></span>
        <span class="flabel">Filter <kbd>F</kbd></span>
        <span class="ftext">{filterOn ? app.filter?.text : 'off'}</span>
        <span aria-hidden="true">{paneState.filterOpen ? '▴' : '▾'}</span>
      </button>
      {#if paneState.filterOpen}
        <div id="pane-filter-builder" class="filterbody">
          <FilterBuilder bind:textEl={filterText} />
        </div>
      {/if}
    </section>

    <section class="tools" aria-label="Tools">
      <button type="button" class="kc" onclick={() => (app.ui.search = true)}>Find target <kbd>/</kbd></button>
      <button type="button" class="kc" onclick={doExport}>Export <kbd>E</kbd></button>
      <button type="button" class="kc" onclick={doCopyR}>Copy R code</button>
    </section>

    <section aria-labelledby="pane-legend">
      <h3 id="pane-legend">Legend</h3>
      <Legend />
    </section>
  </div>

  <!-- Phones: the heading and settings sit at the foot of the sheet, visible even when it is collapsed. -->
  {#if paneState.phone}{@render bar()}{/if}
</aside>

{#snippet bar()}
  <header class="bar" class:bottom={paneState.phone}>
    <h2><Wordmark size={paneState.phone ? '1.05rem' : '1.15rem'} /></h2>
    <div class="topbtns">
      <button type="button" class="icon kc" onclick={() => (app.ui.settings = true)} aria-label="Settings" title="Settings (;)">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
          ><path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.4h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z"
            stroke="currentColor"
            stroke-width="1.8"
            fill="none"
            stroke-linejoin="round"
          /></svg
        >
      </button>
      {#if !paneState.phone}
        <button type="button" class="icon kc" onclick={() => (app.ui.paneOpen = false)} aria-label="Hide side pane" title="Hide pane">»</button>
      {/if}
    </div>
  </header>
{/snippet}

<style>
  .pane {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--pane-w);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    color: var(--fg);
    border-left: 1px solid var(--line);
    z-index: 20;
    transition:
      transform 0.25s ease,
      opacity 0.15s linear;
  }
  .pane.closed {
    transform: translateX(100%);
  }
  .pane.hidden {
    visibility: hidden;
    pointer-events: none;
  }
  .pane.phone {
    top: auto;
    left: 0;
    width: auto;
    border-left: 0;
    border-top: 1px solid var(--line);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -6px 24px rgb(0 0 0 / 0.12);
    transition:
      height 0.25s ease,
      opacity 0.15s linear;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .pane.phone.dragging {
    transition: none;
  }
  :global(.reduced-motion) .pane {
    transition: opacity 0.15s linear;
  }
  .handle {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-height: 56px;
    padding: 8px 16px;
    border: 0;
    background: transparent;
    color: var(--fg);
    cursor: grab;
    touch-action: none;
  }
  .grip {
    width: 40px;
    height: 5px;
    border-radius: 3px;
    background: var(--line);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex: none;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px 14px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .bar.bottom {
    min-height: 56px;
    padding: 0 12px 0 14px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  h2 {
    margin: 0;
    line-height: 1;
  }
  h3 {
    margin: 0 0 6px;
    font: 600 0.66rem var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  kbd {
    font: 500 0.7rem var(--font-mono);
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--muted);
    text-transform: none;
  }
  .topbtns {
    display: flex;
    gap: 4px;
  }
  button {
    font: inherit;
  }
  .icon,
  .reopen {
    width: 44px;
    height: 44px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 1.1rem;
      display: inline-grid;
    place-items: center;
}
  .reopen {
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 20;
  }
  .filterbtn {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    text-align: left;
  }
  .filterbtn .accent {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    border: 2px solid var(--line);
    flex: none;
  }
  .filterbtn.on .accent {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .flabel {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ftext {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    color: var(--muted);
    text-align: right;
  }
  .filterbtn.on .ftext {
    color: var(--fg);
  }
  .filterbody {
    margin-top: 8px;
  }
  .tools {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .tools button {
    min-height: 44px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .tools button:first-child {
    grid-column: 1 / -1;
  }
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
