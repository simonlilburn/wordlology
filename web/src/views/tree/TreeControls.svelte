<script lang="ts">
  // Visible Tree view controls: zoom +, −, Fit; Skip during the growth
  // animation; the computing status; the deterministic-strategy note.
  import { treeControls } from '../../scene/tree/controls';
  import { treeUi } from '../../scene/tree/ui.svelte';
  import { fmtInt } from './pathinfo';

  const vp = $derived(treeUi.viewport);
  const shown = $derived(treeUi.alpha > 0.02);
  const status = $derived.by(() => {
    const c = treeUi.computing;
    if (!c) return '';
    return `computing ${fmtInt(c.done)} / ${fmtInt(c.total)}`;
  });
</script>

{#if shown}
  <div
    class="zoom"
    style:left="{vp.left + 12}px"
    style:top="{vp.top + vp.height - 12}px"
    style:opacity={treeUi.alpha}
    inert={!treeUi.active}
    role="group"
    aria-label="Tree zoom"
  >
    <button type="button" onclick={() => treeControls.zoomIn()} disabled={treeUi.atMax} title="Zoom in" aria-label="Zoom in">
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
    </button>
    <button
      type="button"
      onclick={() => treeControls.zoomOut()}
      title={treeUi.atFit ? 'Zoom out to the Card view' : 'Zoom out'}
      aria-label={treeUi.atFit ? 'Zoom out to the Card view' : 'Zoom out'}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
    </button>
    <button type="button" class="fit" onclick={() => treeControls.fit()} title="Fit the whole tree" aria-label="Fit the whole tree">Fit</button>
  </div>

  <div class="status" style:left="{vp.left + vp.width / 2}px" style:top="{vp.top + vp.height - 12}px" style:opacity={treeUi.alpha} inert={!treeUi.active}>
    {#if treeUi.deterministic}
      <p class="note">Deterministic strategy: one game per target.</p>
    {/if}
    {#if status && (treeUi.stalled || !treeUi.growing)}
      <p class="computing" role="status">{status}</p>
    {/if}
    {#if treeUi.growing}
      <button type="button" class="skip" onclick={() => treeControls.skip()}>Skip ▸</button>
    {/if}
  </div>
{/if}

<style>
  .zoom {
    position: absolute;
    z-index: 8;
    transform: translateY(-100%);
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
  }
  .zoom button {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }
  .zoom button:hover:not(:disabled) {
    background: var(--panel);
  }
  .zoom button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .zoom button:focus-visible,
  .skip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .zoom .fit {
    font-size: 0.8rem;
    font-weight: 700;
  }
  .status {
    position: absolute;
    z-index: 8;
    transform: translate(-50%, -100%);
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: none;
  }
  .status > * {
    pointer-events: auto;
  }
  .note,
  .computing {
    margin: 0;
    padding: 6px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.82rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .skip {
    min-height: 44px;
    padding: 0 18px;
    border: none;
    border-radius: 999px;
    background: var(--fg);
    color: var(--bg);
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.15);
  }
</style>
