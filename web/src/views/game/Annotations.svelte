<script lang="ts">
  // Replay annotations: a narrow column beside each row with candidates
  // before → after, expected and observed bits, the strategy's probability of
  // the guess, and the hybrid phase. Tapping the candidate count lists the
  // remaining words.
  import { app } from '../../app/store.svelte';
  import { feedback } from '../../model/feedback';
  import { fmtBits, fmtCount, fmtProb, turnStats, type TurnStats } from './candidates';
  import { attempt } from './services';
  import { boardRows, view } from './state.svelte';

  let { rows }: { rows: number } = $props();

  const path = $derived(boardRows());
  const cursor = $derived(app.replay.cursor);
  const answerWords = $derived(app.words ? app.words.answers.map((id) => app.words!.guesses[id]) : []);
  const computed = $derived.by(() =>
    attempt<{ stats: TurnStats[]; remaining: string[][] } | null>(() => turnStats(answerWords, path, feedback), null),
  );

  function describe(i: number, s: TurnStats | undefined): string {
    const m = view.meta[i];
    const parts: string[] = [];
    if (s) {
      parts.push(`candidates ${fmtCount(s.before)} before, ${fmtCount(s.after)} after`);
      parts.push(`expected ${fmtBits(s.bitsExpected)} bits, observed ${fmtBits(s.bitsObserved)} bits`);
    }
    if (m?.pChosen != null) parts.push(`strategy probability ${fmtProb(m.pChosen)}`);
    if (m?.phase) parts.push(`phase ${m.phase}`);
    if (m?.source === 'player') parts.push('your guess');
    return `Guess ${i + 1}: ${parts.join('; ')}`;
  }
</script>

<div class="annots" style="--rows: {rows}" role="list" aria-label="Annotations">
  {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
    {@const s = computed?.stats[i]}
    {@const m = view.meta[i]}
    <div class="cell" class:dim={i >= cursor} role="listitem" aria-label={i < path.length ? describe(i, s) : undefined}>
      {#if i < path.length}
        <div class="line">
          {#if s}
            <button
              class="cands"
              type="button"
              title="List the {fmtCount(s.after)} remaining {s.after === 1 ? 'word' : 'words'}"
              aria-label="{fmtCount(s.before)} candidates before, {fmtCount(s.after)} after. List the remaining words"
              onclick={() => (view.listRow = i)}
            >
              {fmtCount(s.before)}<span class="arrow">→</span>{fmtCount(s.after)}
            </button>
          {:else}
            <span class="muted">—</span>
          {/if}
          <span class="p" title="The strategy's probability of this guess"
            >{m?.pChosen != null ? `p ${fmtProb(m.pChosen)}` : 'p —'}</span
          >
        </div>
        <div class="line small">
          {#if s}
            <span title="Expected / observed information in bits">{fmtBits(s.bitsExpected)}/{fmtBits(s.bitsObserved)} b</span>
          {/if}
          {#if m?.phase}<span class="phase" class:player={m.source === 'player'} title="Phase: {m.phase}">{m.phase}</span>{/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .annots {
    display: grid;
    grid-template-rows: repeat(var(--rows), var(--tile));
    gap: var(--gap);
    width: var(--annot);
    font-size: 0.72rem;
    line-height: 1.25;
    font-variant-numeric: tabular-nums;
  }
  .cell {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-width: 0;
    padding-left: 8px;
    border-left: 2px solid var(--line);
    transition: opacity 180ms ease;
  }
  .cell.dim {
    opacity: 0.35;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    min-width: 0;
  }
  .small {
    color: var(--muted);
  }
  .cands {
    border: none;
    background: var(--panel);
    color: var(--fg);
    font: inherit;
    font-weight: 700;
    padding: 2px 6px;
    margin: -2px 0 -2px -2px;
    border-radius: 6px;
    cursor: pointer;
    min-height: 24px;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .cands:hover {
    background: var(--line);
  }
  .cands:focus-visible {
    outline: 2px solid var(--accent);
  }
  .arrow {
    margin: 0 2px;
    color: var(--muted);
    font-weight: 400;
  }
  .p {
    color: var(--muted);
  }
  .phase {
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 5px;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-size: 0.66rem;
  }
  .phase.player {
    border-color: var(--accent);
    color: var(--accent);
  }
  .muted {
    color: var(--muted);
  }
</style>
