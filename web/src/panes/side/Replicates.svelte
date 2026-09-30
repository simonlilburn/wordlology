<script lang="ts">
  // Replicates R for the Tree view (stochastic strategies only).
  import { app } from '../../app/store.svelte';
  import { fmtInt } from '../util';
  import { deterministic, focusedSpec } from '../services';

  const OPTIONS = [50, 200, 1000];
  const det = $derived(deterministic(focusedSpec()));
</script>

{#if det}
  <p class="note">Deterministic strategy: one game per target.</p>
{:else}
  <div class="reps" role="group" aria-label="Replicates per target in the Tree view">
    {#each OPTIONS as n (n)}
      <button type="button" class:on={app.result.replicatesTree === n} aria-pressed={app.result.replicatesTree === n} onclick={() => (app.result.replicatesTree = n)}>
        {fmtInt(n)}
      </button>
    {/each}
  </div>
  <p class="note">Games drawn against this target. More games show rarer branches.</p>
{/if}

<style>
  .reps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  button {
    min-height: 44px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  button.on {
    border-color: var(--fg);
    background: var(--fg);
    color: var(--bg);
    font-weight: 600;
  }
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
  .note {
    margin: 6px 0 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
</style>
