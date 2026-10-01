<script lang="ts">
  // Level buttons: Game, Tree, Card, Atlas.
  import { setLevel } from '../../app/actions';
  import { app, LEVEL_NAMES, type Level } from '../../app/store.svelte';

  const current = $derived(Math.round(app.zTarget));
</script>

<div class="levels" role="group" aria-label="Level">
  {#each LEVEL_NAMES as name, i (name)}
    <button type="button" class:on={current === i} aria-pressed={current === i} onclick={() => setLevel(i as Level)}>
      {name}
    </button>
  {/each}
</div>

<style>
  .levels {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  button {
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-size: 0.9rem;
  }
  button + button {
    border-left: 1px solid var(--line);
  }
  button.on {
    background: var(--fg);
    color: var(--bg);
    font-weight: 600;
  }
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }
</style>
