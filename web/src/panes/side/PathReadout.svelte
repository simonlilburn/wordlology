<script lang="ts">
  // The selected path in the focused tree: its guesses, outcome and probability, and Play.
  import { openReplay, selectNode } from '../../app/actions';
  import { app } from '../../app/store.svelte';
  import { focusData } from '../../model/focus';
  import type { TrieNode } from '../../model/types';
  import { live } from '../live.svelte';
  import { isSpoiler } from '../services';
  import { attempt, fmtInt, fmtProb } from '../util';
  import FeedbackStrip from './FeedbackStrip.svelte';

  function pathOf(node: TrieNode): TrieNode[] {
    const tree = focusData.tree;
    let p = tree ? attempt(() => tree.pathTo(node), [] as TrieNode[]) : [];
    if (!p.length) {
      for (let n: TrieNode | null = node; n; n = n.parent) p.unshift(n);
    }
    return p.filter((n) => n.depth >= 1);
  }

  // Catalogue numbers: each answer's place in the alphabetical answer list, as in a field guide.
  const catalogue = $derived.by(() => {
    const words = app.words;
    if (!words) return null;
    const sorted = Array.from(words.answers, (id) => words.guesses[id]).sort();
    return new Map(sorted.map((w, i) => [w, i + 1]));
  });

  const info = $derived.by(() => {
    void live.tree;
    const id = app.focus.node;
    const tree = focusData.tree;
    const words = app.words;
    if (id < 0 || !tree || !words || isSpoiler(tree.target)) return null;
    const node = tree.nodes[id];
    if (!node) return null;
    const path = pathOf(node);
    const total = tree.totalMass;
    const maxG = app.result.maxGuesses;
    let outcome: string;
    if (node.mass === 0 && node.player) outcome = 'Your game (carries no mass)';
    else if (node.endSolved > 0 && node.children.length === 0) outcome = `Solved in ${node.depth}`;
    else if (node.endFailed > 0 && node.children.length === 0) outcome = `Not solved in ${maxG}`;
    else outcome = `Partial path: ${fmtInt(node.mass)} game${node.mass === 1 ? '' : 's'} continue from here`;
    const targetWord = words.guesses[words.answers[tree.target]] ?? '';
    return {
      target: tree.target,
      targetWord,
      number: catalogue?.get(targetWord) ?? 0,
      of: words.answers.length,
      path,
      rows: path.map((n) => ({ word: words.guesses[n.guess] ?? '?', pattern: n.pattern, p: n.pEdge, player: n.player && n.mass === 0 })),
      outcome,
      mass: node.mass,
      total,
      prob: total > 0 ? node.mass / total : 0,
    };
  });

  function play() {
    const i = info;
    if (!i) return;
    try {
      openReplay({
        target: i.target,
        guesses: i.path.map((n) => n.guess),
        patterns: i.path.map((n) => n.pattern),
        config: focusData.treeRun?.config ?? null,
      });
    } catch {
      // Platform not ready.
    }
  }
</script>

{#if info}
  <section class="readout" aria-label="Selected path" aria-live="polite">
    {#if info.number}
      <p class="cat">
        <span>No. {fmtInt(info.number)} / {fmtInt(info.of)}</span>
        <span class="tw">{info.targetWord.toUpperCase()}</span>
      </p>
    {/if}
    <ol class="guesses">
      {#each info.rows as r, i (i)}
        <li>
          <FeedbackStrip word={r.word} pattern={r.pattern} size={20} />
          {#if !r.player && Number.isFinite(r.p) && r.p > 0 && r.p < 1}
            <span class="p" title="Share of games from the previous guess that chose this one">{fmtProb(r.p)}</span>
          {/if}
        </li>
      {/each}
    </ol>
    <p class="outcome">{info.outcome}</p>
    {#if info.total > 0 && info.mass > 0}
      <p class="prob">
        Probability <strong>{fmtProb(info.prob)}</strong>
        <span class="muted">({fmtInt(info.mass)} of {fmtInt(info.total)} games)</span>
      </p>
    {/if}
    <div class="actions">
      <button type="button" class="kc primary" onclick={play}>▶ Play</button>
      <button type="button" class="kc" onclick={() => attempt(() => selectNode(-1), undefined)}>Clear</button>
    </div>
  </section>
{/if}

<style>
  .readout {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 10px 12px 12px;
    background: var(--bg);
  }
  .cat {
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font: 500 0.66rem var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .tw {
    color: var(--fg);
    font-weight: 700;
  }
  .guesses {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .guesses li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .p {
    font-size: 0.75rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .outcome {
    margin: 10px 0 2px;
    font-family: var(--font-display);
    font-stretch: 90%;
    font-weight: 750;
    font-size: 1.3rem;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .prob {
    margin: 0;
    font-size: 0.85rem;
  }
  .muted {
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  button {
    min-height: 44px;
    padding: 0 18px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    font-weight: 700;
    cursor: pointer;
  }
  .primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
