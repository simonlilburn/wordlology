<script lang="ts">
  // Readout: nodes matched, games touching a match (count and share of R), and matches per row.
  import { app } from '../../app/store.svelte';
  import { compileFilter } from '../../model/filter';
  import { focusData } from '../../model/focus';
  import { live } from '../live.svelte';
  import { fmtInt, fmtPct } from '../util';
  import { filterReadout } from './builder';

  const readout = $derived.by(() => {
    void live.tree;
    const words = app.words;
    const tree = focusData.tree;
    if (!words || !tree) return null;
    const f = compileFilter(app.filter, words.wordLength, app.display.yIsVowel);
    if (!f) return null;
    const targetWord = words.answers[tree.target] ?? -1;
    return filterReadout(tree, words.guesses, targetWord, f, app.result.maxGuesses);
  });

  const maxRow = $derived(readout ? Math.max(1, ...readout.perRow.map((r) => r.games)) : 1);
</script>

{#if readout}
  <div class="readout" aria-live="polite">
    <p class="big">
      <strong>{fmtInt(readout.nodes)}</strong> node{readout.nodes === 1 ? '' : 's'} matched ·
      <strong>{fmtInt(readout.games)}</strong> of {fmtInt(readout.totalGames)} games touch a match
      <span class="share">({fmtPct(readout.share)})</span>
    </p>
    <table>
      <caption class="visually-hidden">Matches per row</caption>
      <thead>
        <tr><th scope="col">Guess</th><th scope="col">Nodes</th><th scope="col">Games</th><th scope="col"><span class="visually-hidden">Bar</span></th></tr>
      </thead>
      <tbody>
        {#each readout.perRow as r (r.row)}
          <tr class:zero={r.nodes === 0}>
            <th scope="row">{r.row}</th>
            <td>{fmtInt(r.nodes)}</td>
            <td>{fmtInt(r.games)}</td>
            <td class="barcell"><span class="bar" style:width="{(r.games / maxRow) * 100}%"></span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if app.filter}
  <p class="muted">The readout appears once the tree has games.</p>
{/if}

<style>
  .big {
    margin: 0 0 6px;
    font-size: 0.85rem;
  }
  .share {
    color: var(--muted);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 2px 4px;
    text-align: right;
  }
  thead th {
    color: var(--muted);
    font-weight: 500;
  }
  tbody th {
    text-align: left;
    font-weight: 500;
  }
  tr.zero {
    color: var(--muted);
  }
  .barcell {
    width: 40%;
    text-align: left;
  }
  .bar {
    display: inline-block;
    height: 8px;
    min-width: 1px;
    border-radius: 2px;
    background: var(--accent);
    vertical-align: middle;
  }
  .muted {
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0;
  }
</style>
