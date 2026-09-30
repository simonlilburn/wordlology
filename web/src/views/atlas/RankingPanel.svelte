<script lang="ts">
  // Owned by the card/atlas agent: a ranking of the full alternative set along
  // one row (strategies for an opener) or one column (openers for a strategy).
  // Entries glide to new positions as estimates change, reordering at most
  // twice a second; the run can be cancelled at any round.
  import { onDestroy } from 'svelte';
  import { flip } from 'svelte/animate';
  import { toast } from '../../app/actions';
  import { app, type StrategyEntry } from '../../app/store.svelte';
  import { FALLBACK_PRESETS } from '../../lab/catalogue';
  import { rankOpeners, rankStrategies, type Ranking, type RankingEntry } from '../../model/rankings';
  import { addColumn, addRow } from '../../scene/atlas/interact';
  import { CARD_H, CARD_W, gridLayout } from '../../scene/atlas/layout';
  import { sceneView } from '../../scene/atlas/view.svelte';
  import { gridAxes } from '../../scene/atlas/cells';
  import { cardTheme, prefersDark, rampPositions, rgbCss, rowFill } from '../../scene/card/ramp';
  import { fmtMetric, METRIC_LABELS, rankingCsv, ReorderThrottle, tieBrackets } from './ranking';

  type Request = { kind: 'row'; opener: string | null } | { kind: 'column'; strategy: string };
  let { request, onclose }: { request: Request; onclose: () => void } = $props();

  const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  function strategyCatalogue(): StrategyEntry[] {
    const presets = app.catalogue.presets.length ? app.catalogue.presets : FALLBACK_PRESETS;
    const out: StrategyEntry[] = [];
    const seen = new Set<string>();
    for (const e of [...presets, ...app.saved, ...app.atlas.columns]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(plain({ id: e.id, label: e.label, colour: e.colour, spec: e.spec }));
    }
    return out;
  }

  function strategySet(): StrategyEntry[] {
    const all = strategyCatalogue();
    const set = app.result.rankStrategySet;
    if (set === 'all') return all;
    const chosen = all.filter((e) => set.includes(e.id));
    return chosen.length ? chosen : all;
  }

  function findStrategy(id: string): StrategyEntry | null {
    return strategyCatalogue().find((e) => e.id === id) ?? null;
  }

  const title = $derived(
    request.kind === 'row'
      ? `Strategies for opener ${request.opener ? request.opener.toUpperCase() : "(strategy's choice)"}`
      : `Openers for ${findStrategy(request.strategy)?.label ?? request.strategy}`,
  );

  let ranking: Ranking | null = null;
  let unsub: (() => void) | null = null;
  let error = $state<string | null>(null);
  let version = $state(0);
  let order = $state<string[]>([]);
  const throttle = new ReorderThrottle(500);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function refresh(): void {
    const r = ranking;
    if (!r) return;
    version++;
    const next = [...r.entries].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).map((e) => e.key);
    const res = throttle.offer(next, performance.now());
    order = [...res.order];
    if (res.pendingMs > 0 && !timer) {
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, res.pendingMs);
    }
  }

  function start(): void {
    try {
      if (request.kind === 'row') {
        ranking = rankStrategies(request.opener, strategySet());
      } else {
        const s = findStrategy(request.strategy);
        if (!s) throw new Error('Unknown strategy');
        const set = app.result.rankOpenerSet;
        ranking = rankOpeners(s, set.kind === 'pasted' ? [...set.words] : null);
      }
      unsub = ranking.onChange(() => refresh());
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = /not implemented/i.test(msg) ? 'Rankings are not available yet in this build.' : `Ranking failed: ${msg}`;
      ranking = null;
    }
  }
  start();

  onDestroy(() => {
    unsub?.();
    if (timer) clearTimeout(timer);
    if (ranking && ranking.status === 'running') {
      try {
        ranking.cancel();
      } catch {
        /* ignore */
      }
    }
  });

  const view = $derived.by(() => {
    void version;
    const r = ranking;
    if (!r) return null;
    const byKey = new Map(r.entries.map((e) => [e.key, e] as const));
    const list = order.map((k) => byKey.get(k)).filter((e): e is RankingEntry => !!e);
    return {
      status: r.status,
      round: r.round,
      rounds: r.rounds,
      metric: r.metric,
      list,
      brackets: tieBrackets(list.map((e) => e.tieGroup)),
    };
  });

  const theme = cardTheme(prefersDark());

  function miniRows(dist: number[]): { fill: string; w: number }[] {
    const ramp = rampPositions(dist);
    let max = 0;
    for (const v of dist) if (v > max) max = v;
    return dist.map((v, i) => ({ fill: rgbCss(rowFill(theme, ramp[i])), w: max > 0 ? v / max : 0 }));
  }

  function provisional(e: RankingEntry): boolean {
    return e.stage === 'screened' || (view?.status === 'running' && e.stage !== 'full');
  }

  function add(e: RankingEntry): void {
    try {
      if (request.kind === 'row') {
        const s = findStrategy(e.key) ?? {
          id: e.key,
          label: e.label,
          colour: e.colour ?? '#888888',
          spec: e.spec ?? { kind: 'max_info', pool: 'candidates' },
        };
        addColumn(plain(s));
        toast(`Added ${s.label} as a column`);
      } else {
        const o = e.opener !== undefined ? e.opener : e.key;
        addRow(o ? o.toLowerCase() : null);
        toast(`Added ${o ? o.toUpperCase() : "strategy's choice"} as a row`);
      }
    } catch (err) {
      console.warn('[ranking]', err);
    }
  }

  function addTop5(): void {
    for (const e of (view?.list ?? []).slice(0, 5)) add(e);
  }

  function exportCsv(): void {
    const r = ranking;
    if (!r) return;
    const csv = rankingCsv(r);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ranking.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function cancel(): void {
    try {
      ranking?.cancel();
    } catch {
      /* ignore */
    }
    refresh();
  }

  // Beside the row (right of its header) or below the column header.
  const panelStyle = $derived.by(() => {
    const vp = sceneView.vp;
    const s = sceneView.s;
    const { columns, rows } = gridAxes();
    const g = gridLayout(columns.length, rows.length);
    const W = Math.min(380, Math.max(260, vp.width - 24));
    let x: number, y: number;
    if (request.kind === 'row') {
      const r = Math.max(0, rows.indexOf(request.opener));
      x = sceneView.tx - 8;
      y = sceneView.ty + r * g.pitchY * s;
    } else {
      const c = Math.max(0, columns.findIndex((e) => e.id === request.strategy));
      x = sceneView.tx + c * g.pitchX * s + (CARD_W * s - W) / 2;
      y = sceneView.ty + 4;
    }
    void CARD_H;
    const left = Math.max(vp.left + 8, Math.min(x, vp.left + vp.width - W - 8));
    const top = Math.max(vp.top + 8, Math.min(y, vp.top + vp.height - 240));
    const maxH = Math.max(200, vp.top + vp.height - top - 8);
    return `left:${left}px;top:${top}px;width:${W}px;max-height:${maxH}px`;
  });

  function keydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<div class="panel" role="dialog" tabindex="-1" aria-label={title} style={panelStyle} onkeydown={keydown}>
  <header>
    <div class="titles">
      <h2>{title}</h2>
      <p class="sub">
        {#if view}
          by {METRIC_LABELS[view.metric]} ·
          {#if view.status === 'running'}round {view.round} of {view.rounds}{:else if view.status === 'done'}done{:else}{view.status}{/if}
        {:else}
          by {METRIC_LABELS[app.result.rankMetric]}
        {/if}
      </p>
    </div>
    <button class="icon" onclick={onclose} aria-label="Close ranking">×</button>
  </header>

  {#if error}
    <p class="note">{error}</p>
  {:else if view}
    <div class="actions">
      {#if view.status === 'running'}<button onclick={cancel}>Cancel</button>{/if}
      <button onclick={addTop5} disabled={!view.list.length}>Add top 5</button>
      <button onclick={exportCsv} disabled={!view.list.length}>ranking.csv</button>
    </div>
    {#if view.status === 'running'}
      <div class="progress" aria-hidden="true"><span style="width:{(100 * Math.max(0, view.round - 1)) / Math.max(1, view.rounds)}%"></span></div>
    {/if}
    <ol class="entries" aria-live="polite" aria-busy={view.status === 'running'}>
      {#each view.list as e, i (e.key)}
        <li animate:flip={{ duration: app.reducedMotion ? 0 : 420 }} class="bracket-{view.brackets[i] ?? 'none'}">
          <button
            class="entry"
            onclick={() => add(e)}
            title={request.kind === 'row' ? 'Add as a strategy column' : 'Add as an opener row'}
          >
            <span class="rank">{e.rank}</span>
            <span class="name">
              {#if request.kind === 'row'}
                <span class="swatch" style="background:{e.colour ?? '#888'}" aria-hidden="true"></span>{e.label}
              {:else}
                <span class="word">{e.label.toUpperCase()}</span>
              {/if}
              {#if e.stage === 'screened'}<span class="badge">screened</span>{/if}
              {#if view.brackets[i] === 'start'}<span class="tie">tied within noise</span>{/if}
            </span>
            <span class="mini" aria-hidden="true">
              {#each miniRows(e.distribution) as r, k (k)}
                <span class="mini-row"><span class="mini-bar" style="width:{(r.w * 100).toFixed(1)}%;background:{r.fill}"></span></span>
              {/each}
            </span>
            <span class="stats">
              <span class="value">{fmtMetric(view.metric, e.value, provisional(e))}</span>
              {#if Number.isFinite(e.ciLow) && Number.isFinite(e.ciHigh)}
                <span class="ci">{fmtMetric(view.metric, e.ciLow, provisional(e))}–{fmtMetric(view.metric, e.ciHigh, provisional(e)).replace('~', '')}</span>
              {/if}
              <span class="fail">{fmtMetric('fail_rate', e.failRate, provisional(e))} fail</span>
            </span>
          </button>
        </li>
      {:else}
        <li class="note">Screening candidates…</li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .panel {
    position: fixed;
    z-index: 14;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 12px 36px rgb(0 0 0 / 0.22);
    overflow: hidden;
    font-size: 13px;
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 6px 6px 14px;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h2 {
    font-size: 15px;
    margin: 4px 0 2px;
    font-weight: 650;
  }
  .sub {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
  .icon {
    width: 44px;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 22px;
    cursor: pointer;
    flex: none;
  }
  .actions {
    display: flex;
    gap: 6px;
    padding: 0 14px 8px;
    flex-wrap: wrap;
  }
  .actions button {
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: var(--fg);
    cursor: pointer;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .progress {
    height: 2px;
    background: var(--line);
    margin: 0 14px 6px;
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 300ms;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0 8px 10px 12px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  li {
    position: relative;
    padding-left: 8px;
  }
  li.bracket-start::before,
  li.bracket-mid::before,
  li.bracket-end::before {
    content: '';
    position: absolute;
    left: 0;
    width: 5px;
    border-left: 2px solid var(--accent);
    top: 0;
    bottom: 0;
  }
  li.bracket-start::before {
    top: 10px;
    border-top: 2px solid var(--accent);
  }
  li.bracket-end::before {
    bottom: 10px;
    border-bottom: 2px solid var(--accent);
  }
  .entry {
    width: 100%;
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) 46px auto;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 4px 6px;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .entry:hover,
  .entry:focus-visible {
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    outline: none;
  }
  .rank {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    text-align: right;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .word {
    font-family: var(--font-mono);
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .swatch {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 5px;
  }
  .badge,
  .tie {
    display: inline-block;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 6px;
    font-size: 10.5px;
    color: var(--muted);
    border: 1px solid var(--line);
  }
  .tie {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .mini {
    display: flex;
    flex-direction: column;
    gap: 1px;
    height: 34px;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 2px;
  }
  .mini-row {
    display: block;
    height: 3px;
  }
  .mini-bar {
    display: block;
    height: 100%;
    min-width: 1px;
    transition: width 300ms ease-out;
    border-radius: 1px;
  }
  .stats {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    font-variant-numeric: tabular-nums;
    line-height: 1.25;
  }
  .value {
    font-weight: 650;
  }
  .ci,
  .fail {
    font-size: 11px;
    color: var(--muted);
  }
  .note {
    padding: 8px 14px 14px;
    margin: 0;
    color: var(--muted);
  }
</style>
