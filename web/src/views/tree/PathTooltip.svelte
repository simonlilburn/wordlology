<script lang="ts">
  // The small tooltip for a hovered or tapped path: its guesses, outcome and
  // probability, with Play (and close) when pinned by a tap.
  import { app } from '../../app/store.svelte';
  import { focusData } from '../../model/focus';
  import { playNode, treeControls } from '../../scene/tree/controls';
  import { treeUi } from '../../scene/tree/ui.svelte';
  import { cells, describeFeedback, fmtInt, fmtProb, pathInfo } from './pathinfo';

  const tip = $derived(treeUi.tooltip);
  const vp = $derived(treeUi.viewport);

  const info = $derived.by(() => {
    const t = tip;
    void treeUi.version;
    const tree = focusData.tree;
    const words = app.words;
    if (!t || !tree || !words || t.kind === 'ellipsis') return null;
    const node = tree.nodes[t.node];
    if (!node) return null;
    return pathInfo(node, words.guesses, tree.totalMass, app.result.maxGuesses, words.wordLength);
  });

  // Keep the tooltip inside the uncovered viewport: below the node if it
  // fits, else above it, else a compact form (no guess rows) wherever there
  // is more room.
  const W = 240;
  const GAP = 8;
  let height = $state(0);
  let fullHeight = $state(0);
  const left = $derived(tip ? Math.min(vp.left + vp.width - W / 2 - 8, Math.max(vp.left + W / 2 + 8, tip.x)) : 0);
  const place = $derived.by(() => {
    if (!tip) return { top: 0, compact: false };
    const lo = vp.top + 4;
    const hi = vp.top + vp.height - 4;
    const below = hi - (tip.y + GAP);
    const above = tip.top - GAP - lo;
    const h = fullHeight || height || 160;
    if (h <= below) return { top: tip.y + GAP, compact: false };
    if (h <= above) return { top: tip.top - GAP - h, compact: false };
    const hc = Math.min(h, height || 110);
    const top = below >= above ? tip.y + GAP : tip.top - GAP - hc;
    return { top: Math.max(lo, Math.min(hi - hc, top)), compact: true };
  });
  $effect(() => {
    if (!place.compact && height) fullHeight = height;
  });
  $effect(() => {
    void tip?.node;
    fullHeight = 0;
  });
</script>

{#if tip && (info || tip.kind === 'ellipsis')}
  <div
    class="tip"
    class:pinned={tip.pinned}
    style:left="{left}px"
    style:top="{place.top}px"
    style:width="{W}px"
    bind:offsetHeight={height}
    role={tip.pinned ? 'dialog' : 'tooltip'}
    aria-label="Path"
  >
    {#if tip.kind === 'ellipsis' && tip.hidden}
      <p class="head">… {fmtInt(tip.hidden.count)} more path{tip.hidden.count === 1 ? '' : 's'} · {fmtInt(tip.hidden.games)} game{tip.hidden.games === 1 ? '' : 's'}</p>
      {#if tip.hidden.matches > 0}
        <p class="muted">{fmtInt(tip.hidden.matches)} filter match{tip.hidden.matches === 1 ? '' : 'es'} inside</p>
      {/if}
      <p class="muted">Tap to show the next {Math.min(12, tip.hidden.count)}.</p>
    {:else if info}
      <ol class="rows" class:compact={place.compact}>
        {#each info.rows as r, i (i)}
          <li aria-label={describeFeedback(r.word, r.pattern)}>
            <span class="word" class:player={r.player}>{r.word}</span>
            <span class="strip" aria-hidden="true">
              {#each cells(r.pattern, [...r.word].length) as c, j (j)}
                <span class="cell c{c}"></span>
              {/each}
            </span>
            {#if !r.player && r.p > 0 && r.p < 1}<span class="p">{fmtProb(r.p)}</span>{/if}
          </li>
        {/each}
      </ol>
      <p class="head">{info.outcome}</p>
      {#if info.total > 0 && info.mass > 0}
        <p class="muted">Probability {fmtProb(info.prob)} ({fmtInt(info.mass)} of {fmtInt(info.total)} games)</p>
      {/if}
      {#if tip.pinned}
        <div class="actions">
          <button type="button" class="play" onclick={() => playNode(tip.node)}>▶ Play</button>
          <button type="button" onclick={() => treeControls.unpin()} aria-label="Close">Close</button>
        </div>
      {:else}
        <p class="hint">Click to select · double-click to play</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .tip {
    position: absolute;
    z-index: 10;
    transform: translateX(-50%);
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 6px 22px rgb(0 0 0 / 0.14);
    font-size: 0.8rem;
    pointer-events: none;
  }
  .rows.compact {
    display: none;
  }
  .tip.pinned {
    pointer-events: auto;
  }
  .rows {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .word {
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.04em;
    min-width: 5.2ch;
  }
  .word.player {
    text-decoration: underline;
    text-decoration-style: dotted;
  }
  .strip {
    display: inline-flex;
    gap: 1px;
  }
  .cell {
    width: 8px;
    height: 8px;
    border-radius: 1.5px;
    background: var(--absent);
  }
  .cell.c1 {
    background: var(--present);
  }
  .cell.c2 {
    background: var(--correct);
  }
  .p {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .head {
    margin: 0;
    font-weight: 700;
  }
  .muted,
  .hint {
    margin: 2px 0 0;
    color: var(--muted);
  }
  .hint {
    font-size: 0.72rem;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .actions button {
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: var(--fg);
    font-weight: 600;
    cursor: pointer;
  }
  .actions .play {
    background: var(--fg);
    color: var(--bg);
    border-color: var(--fg);
  }
  .actions button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
