<script lang="ts">
  // A mini card: the seven-row outcome distribution with bars, and the mean.
  import { fmtNum, fmtPct, outcomeLabels } from '../panes/util';

  let {
    shares,
    mean,
    colour = 'var(--accent)',
    caption = 'Outcome distribution',
    provisional = false,
    compare = null,
  }: {
    shares: number[];
    mean: number;
    colour?: string;
    caption?: string;
    provisional?: boolean;
    /** Another card's mean to compare with (e.g. the current card), or null. */
    compare?: { label: string; mean: number } | null;
  } = $props();

  const labels = $derived(outcomeLabels(Math.max(1, shares.length - 1)));
  const maxShare = $derived(Math.max(1e-9, ...shares));
  const tilde = $derived(provisional ? '~' : '');
</script>

<figure class="mini" style:--c={colour}>
  <table>
    <caption>{caption}</caption>
    <thead class="visually-hidden">
      <tr><th scope="col">Guesses</th><th scope="col">Share</th></tr>
    </thead>
    <tbody>
      {#each shares as s, i (i)}
        <tr style:--shade={(s / maxShare).toFixed(3)}>
          <th scope="row">{labels[i]}</th>
          <td class="barcell">
            <span class="bar" style:width="{(s / maxShare) * 100}%"></span>
            <span class="pct">{tilde}{fmtPct(s, provisional ? 0 : 1)}</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <figcaption>
    Mean <strong>{tilde}{fmtNum(mean, provisional ? 1 : 2)}</strong> guesses
    {#if compare && Number.isFinite(compare.mean)}
      <span class="cmp">· {compare.label} {fmtNum(compare.mean, 2)}</span>
    {/if}
  </figcaption>
</figure>

<style>
  .mini {
    margin: 0;
    padding: 10px;
    border: 1px solid var(--line);
    border-top: 4px solid var(--c);
    border-radius: var(--radius);
    background: var(--bg);
    max-width: 320px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  caption {
    text-align: left;
    font-size: 0.75rem;
    color: var(--muted);
    padding-bottom: 4px;
  }
  tr {
    background: color-mix(in srgb, var(--fg) calc(var(--shade) * 10%), transparent);
  }
  th {
    width: 1.6em;
    padding: 3px 4px;
    text-align: center;
    font-weight: 600;
  }
  .barcell {
    position: relative;
    padding: 3px 4px;
  }
  .bar {
    display: block;
    height: 10px;
    min-width: 1px;
    border-radius: 2px;
    background: var(--c);
  }
  .pct {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.72rem;
  }
  figcaption {
    margin-top: 6px;
    font-size: 0.85rem;
  }
  .cmp {
    color: var(--muted);
  }
</style>
