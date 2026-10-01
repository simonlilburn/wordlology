<script lang="ts">
  // On-screen keyboard. Keys show the best feedback seen for their letter,
  // with the same colour-blind marks as the tiles.
  import { app } from '../../app/store.svelte';
  import { KEY_ROWS, keyLabel, keyStates, CELL_NAMES } from './logic';
  import { inReplay, playedRows, press } from './state.svelte';

  const states = $derived(keyStates(playedRows()));
  const marks = $derived(app.display.colourBlindMarks);
  const enterLabel = $derived(inReplay() && app.game.input.length === 0 ? 'Next' : 'Enter');

  function tap(k: string) {
    if (k === 'enter') press({ kind: 'enter' });
    else if (k === 'backspace') press({ kind: 'backspace' });
    else press({ kind: 'letter', letter: k });
  }
</script>

<div class="kb" role="group" aria-label="Keyboard">
  {#each KEY_ROWS as row, r (r)}
    <div class="krow">
      {#if r === 1}<span class="half" aria-hidden="true"></span>{/if}
      {#each row as k (k)}
        {@const cell = states.get(k)}
        {#if k === 'enter'}
          <button type="button" class="key wide" data-key="enter" onmousedown={(e) => e.preventDefault()} onclick={() => tap(k)}>
            {enterLabel}
          </button>
        {:else if k === 'backspace'}
          <button
            type="button"
            class="key wide"
            data-key="backspace"
            aria-label="Backspace"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => tap(k)}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"
              ><path
                d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zm-3.3 10.3-1.4 1.4L13 13.4l-3.3 3.3-1.4-1.4 3.3-3.3-3.3-3.3 1.4-1.4 3.3 3.3 3.3-3.3 1.4 1.4-3.3 3.3 3.3 3.3z"
                fill="currentColor"
              /></svg
            >
          </button>
        {:else}
          <button
            type="button"
            class="key {cell !== undefined ? CELL_NAMES[cell] : ''}"
            data-key={k}
            aria-label={keyLabel(k, cell)}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => tap(k)}
          >
            {k}
            {#if marks && cell !== undefined && cell > 0}<span class="mark" aria-hidden="true"></span>{/if}
          </button>
        {/if}
      {/each}
      {#if r === 1}<span class="half" aria-hidden="true"></span>{/if}
    </div>
  {/each}
</div>

<style>
  .kb {
    width: 100%;
    max-width: 500px;
    margin: 0 auto;
    padding: 0 4px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 7px;
    user-select: none;
    touch-action: manipulation;
  }
  .krow {
    display: flex;
    gap: 5px;
  }
  .half {
    flex: 0.5;
  }
  .key {
    position: relative;
    flex: 1;
    min-width: 0;
    height: var(--key-h, 56px);
    min-height: 44px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: var(--key-bg);
    color: var(--fg);
    box-shadow: inset 0 -2px 0 var(--key-edge);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.1rem;
    text-transform: uppercase;
    cursor: pointer;
    display: grid;
    place-items: center;
    -webkit-tap-highlight-color: transparent;
  }
  .key.wide {
    flex: 1.5;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 600;
  }
  .key:active {
    filter: brightness(0.9);
  }
  .key:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .key.absent {
    background: var(--absent);
    color: var(--tile-text);
  }
  .key.present {
    background: var(--present);
    color: var(--tile-text);
  }
  .key.correct {
    background: var(--correct);
    color: var(--tile-text);
  }
  .mark {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 7px;
    height: 7px;
    box-sizing: border-box;
    border-radius: 50%;
  }
  .correct .mark {
    background: currentColor;
  }
  .present .mark {
    border: 1.5px solid currentColor;
  }
</style>
