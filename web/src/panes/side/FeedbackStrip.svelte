<script lang="ts">
  // A guess as a mini strip of feedback tiles (with the colour-blind marks).
  import { app } from '../../app/store.svelte';
  import { cellsOf, describeGuess } from '../util';

  let { word, pattern, size = 22 }: { word: string; pattern: number; size?: number } = $props();

  const cells = $derived(cellsOf(pattern, word.length));
  const kinds = ['absent', 'present', 'correct'] as const;
</script>

<span class="strip" role="img" aria-label={describeGuess(word, pattern)} style:--s="{size}px">
  {#each [...word] as letter, i (i)}
    <span class="cell {kinds[cells[i]]}" class:marks={app.display.colourBlindMarks} aria-hidden="true">{letter.toUpperCase()}</span>
  {/each}
</span>

<style>
  .strip {
    display: inline-flex;
    gap: 2px;
    font-family: var(--font-mono);
    font-weight: 700;
    vertical-align: middle;
  }
  .cell {
    position: relative;
    width: var(--s);
    height: var(--s);
    display: grid;
    place-items: center;
    font-size: calc(var(--s) * 0.58);
    color: var(--tile-text);
    border-radius: 3px;
  }
  .correct {
    background: var(--correct);
  }
  .present {
    background: var(--present);
  }
  .absent {
    background: var(--absent);
  }
  .marks.correct::after,
  .marks.present::after {
    content: '';
    position: absolute;
    top: 2px;
    right: 2px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
  }
  .marks.correct::after {
    background: var(--tile-text);
  }
  .marks.present::after {
    border: 1px solid var(--tile-text);
    width: 3px;
    height: 3px;
  }
</style>
