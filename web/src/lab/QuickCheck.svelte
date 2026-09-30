<script lang="ts">
  // Quick check: 200 sampled targets at R = 5 for the draft, shown as a mini card.
  import { onDestroy } from 'svelte';
  import { app } from '../app/store.svelte';
  import type { StrategySpec } from '../backend/types';
  import { focusData } from '../model/focus';
  import { runs } from '../model/runs';
  import type { Run } from '../model/types';
  import { targetWeights } from '../model/wordlists';
  import { configFor, plain } from '../panes/services';
  import { attempt, fmtInt } from '../panes/util';
  import MiniCard from './MiniCard.svelte';
  import { miniCard, QUICK_REPLICATES, QUICK_TARGETS } from './quick';
  import { specKey } from './state.svelte';

  let {
    spec,
    colour,
    blocked = null,
  }: {
    spec: StrategySpec;
    colour: string;
    /** Why the check cannot run (invalid spec, unsupported list), or null. */
    blocked?: string | null;
  } = $props();

  let run = $state.raw<Run | null>(null);
  let ranKey = $state('');
  let tick = $state(0);
  let error = $state('');
  let off: (() => void) | null = null;
  let frame = 0;

  const withOpener = $derived(app.focus.opener);
  const stale = $derived(!!run && ranKey !== `${specKey(spec)}|${withOpener ?? ''}`);

  function start() {
    error = '';
    const config = configFor(plain(spec), withOpener, 'card', QUICK_REPLICATES);
    if (!config) {
      error = 'The solver is not ready yet.';
      return;
    }
    const r = attempt<Run | null>(() => runs.request(config, { targets: { sample: QUICK_TARGETS } }, 'focused'), null);
    if (!r) {
      error = 'Could not start the check.';
      return;
    }
    off?.();
    run = r;
    ranKey = `${specKey(spec)}|${withOpener ?? ''}`;
    tick++;
    off = r.onChange(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        tick++;
      });
    });
  }

  const result = $derived.by(() => {
    void tick;
    const r = run;
    const words = app.words;
    if (!r) return null;
    const maxGuesses = r.config.rules.max_guesses;
    const w = words ? attempt(() => targetWeights(words, r.config.weighting), null) : null;
    const card = miniCard(r.games, maxGuesses, w ? (t) => w[t] ?? 0 : undefined);
    const total = r.progress?.total ?? QUICK_TARGETS * (r.deterministic ? 1 : QUICK_REPLICATES);
    return { card, done: r.games.length, total, status: r.status, error: r.error, deterministic: r.deterministic };
  });

  const current = $derived.by(() => {
    void tick;
    const c = focusData.card;
    if (!c || !app.focus.strategy) return null;
    const snap = attempt(() => c.snapshot(), null);
    return snap && snap.nGames > 0 ? { label: `Current card (${app.focus.strategy.label})`, mean: snap.mean } : null;
  });

  onDestroy(() => {
    off?.();
    if (frame) cancelAnimationFrame(frame);
    // Leave the check to finish in the background (the cache keeps it).
    if (run && run.status !== 'done') attempt(() => run!.setPriority('background'), undefined);
  });
</script>

<section class="quick" aria-labelledby="quick-h">
  <div class="head">
    <h3 id="quick-h">Quick check</h3>
    <button type="button" onclick={start} disabled={!!blocked} aria-describedby="quick-note">
      {run && !stale ? 'Run again' : 'Quick check'}
    </button>
  </div>
  <p class="note" id="quick-note">
    {#if blocked}{blocked}{:else}{fmtInt(QUICK_TARGETS)} sampled targets at R = {QUICK_REPLICATES}{withOpener ? `, opener ${withOpener.toUpperCase()}` : ", strategy's own opener"}.{/if}
  </p>
  {#if error}<p class="issue" role="alert">{error}</p>{/if}
  {#if result}
    {#if result.status === 'error'}
      <p class="issue" role="alert">The check failed: {result.error}</p>
    {:else}
      <p class="progress" aria-live="polite">
        {#if result.status === 'done'}Done: {fmtInt(result.card.nGames)} games over {fmtInt(result.card.nTargets)} targets.{:else}Computing {fmtInt(result.done)} / {fmtInt(result.total)} games…{/if}
        {#if stale}<strong>The strategy has changed since this check.</strong>{/if}
      </p>
      {#if result.card.nGames > 0}
        <MiniCard
          shares={result.card.shares}
          mean={result.card.mean}
          {colour}
          provisional={result.status !== 'done'}
          caption="Quick check: share of games by guesses"
          compare={current}
        />
      {/if}
    {/if}
  {/if}
</section>

<style>
  .quick {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .note,
  .progress {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .progress strong {
    color: var(--fg);
    font-weight: 600;
  }
  .issue {
    margin: 0;
    font-size: 0.8rem;
    color: #c03030;
  }
  button {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
