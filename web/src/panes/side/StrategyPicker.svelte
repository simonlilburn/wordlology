<script lang="ts">
  // Strategy: presets from the backend's catalogue, saved strategies, and the Strategy Lab.
  import { setStrategy } from '../../app/actions';
  import { app, type StrategyEntry } from '../../app/store.svelte';
  import { unsupportedReason } from '../../lab/lab';
  import { hasFrequencies, isCurrent, presetEntry, presets, schemas } from '../services';

  const entries = $derived.by(() => {
    const list: { entry: StrategyEntry; saved: boolean }[] = presets().map((p) => ({ entry: presetEntry(p), saved: false }));
    for (const s of app.saved) list.push({ entry: s, saved: true });
    // A focused strategy that is neither a preset nor saved (e.g. from a link) is listed too.
    const f = app.focus.strategy;
    if (f && !list.some((e) => e.entry.id === f.id)) list.push({ entry: f, saved: false });
    return list;
  });

  const freq = $derived(hasFrequencies());

  function choose(entry: StrategyEntry) {
    try {
      setStrategy($state.snapshot(entry) as StrategyEntry);
    } catch {
      // Platform not ready.
    }
  }
</script>

<ul class="list" data-strategy-list aria-label="Strategy">
  {#each entries as { entry, saved } (entry.id)}
    {@const reason = unsupportedReason(entry.spec, schemas(), freq)}
    {@const current = isCurrent(entry)}
    <li>
      <button
        type="button"
        class="item"
        class:current
        aria-pressed={current}
        disabled={!!reason}
        title={reason ?? undefined}
        aria-describedby={reason ? `why-${entry.id}` : undefined}
        onclick={() => choose(entry)}
      >
        <span class="swatch" style:background={entry.colour} aria-hidden="true"></span>
        <span class="name">{entry.label}</span>
        {#if saved}<span class="tag">saved</span>{/if}
        {#if current}<span class="check" aria-hidden="true">✓</span>{/if}
      </button>
      {#if reason}<p class="why" id="why-{entry.id}">{reason}</p>{/if}
    </li>
  {/each}
  <li>
    <button type="button" class="item lab" onclick={() => (app.ui.lab = true)}>
      <span class="swatch plus" aria-hidden="true">+</span>
      <span class="name">Strategy Lab…</span>
    </button>
  </li>
</ul>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
  }
  .item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fg) 6%, transparent);
  }
  .item.current {
    border-color: var(--fg);
    background: var(--bg);
    font-weight: 700;
    box-shadow: inset 0 -2px 0 var(--key-edge);
  }
  .item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .item:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
  .swatch {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    box-shadow: inset 0 -2px 0 rgb(0 0 0 / 0.18);
  }
  .swatch.plus {
    display: grid;
    place-items: center;
    border: 1px dashed var(--muted);
    color: var(--muted);
    font-size: 12px;
    line-height: 1;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .tag {
    font-size: 0.72rem;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 6px;
  }
  /* The selected strategy's check is a small tile in the accent green. */
  .check {
    flex: none;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 4px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.72rem;
    font-weight: 800;
  }
  .why {
    margin: 0 10px 4px 34px;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .lab .name {
    color: var(--accent);
  }
</style>
