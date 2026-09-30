<script lang="ts">
  // Legend: tile colours with their marks, the river width scale, and the filter accent.
  import { app } from '../../app/store.svelte';
  import { filterActive } from '../../model/filter';
  import { paneState } from '../state.svelte';
  import { fmtNum } from '../util';

  const scale = $derived(paneState.riverGamesPerPx);
  const tiles = [
    { cls: 'correct', letter: 'C', text: 'Right letter, right place', mark: 'filled dot' },
    { cls: 'present', letter: 'R', text: 'In the word, elsewhere', mark: 'hollow ring' },
    { cls: 'absent', letter: 'A', text: 'Not in the word', mark: 'no mark' },
  ];
</script>

<dl class="legend">
  {#each tiles as t (t.cls)}
    <div class="item">
      <dt>
        <span class="tile {t.cls}" class:marks={app.display.colourBlindMarks} aria-hidden="true">{t.letter}</span>
        <span class="visually-hidden">{t.cls}, {t.mark}</span>
      </dt>
      <dd>{t.text}{app.display.colourBlindMarks ? ` (${t.mark})` : ''}</dd>
    </div>
  {/each}
  <div class="item">
    <dt>
      <svg width="28" height="22" viewBox="0 0 28 22" aria-hidden="true">
        <path d="M4 2 C4 12, 14 10, 14 20 L20 20 C20 10, 24 12, 24 2 Z" fill="currentColor" opacity="0.45" />
        <path d="M14 2 L14 20" stroke="currentColor" stroke-width="1" />
      </svg>
    </dt>
    <dd>
      River width is proportional to the games it carries{#if scale && scale > 0}: 1 px = {scale >= 10 ? Math.round(scale) : fmtNum(scale, scale < 1 ? 2 : 1)}
        game{scale === 1 ? '' : 's'}{:else} (1 px minimum){/if}.
    </dd>
  </div>
  <div class="item">
    <dt><span class="node match" aria-hidden="true">ABC</span></dt>
    <dd>
      Matches the letter filter{#if filterActive(app.filter)}{app.filter?.mode === 'isolate' ? '; other paths are removed' : '; other paths dim'}{/if}.
    </dd>
  </div>
</dl>

<style>
  .legend {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.82rem;
  }
  .item {
    display: grid;
    grid-template-columns: 36px 1fr;
    align-items: center;
    gap: 8px;
  }
  dt {
    display: grid;
    place-items: center;
    color: var(--fg);
  }
  dd {
    margin: 0;
    color: var(--muted);
  }
  .tile {
    position: relative;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 3px;
    color: var(--tile-text);
    font-weight: 700;
    font-size: 0.8rem;
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
    width: 5px;
    height: 5px;
    border-radius: 50%;
  }
  .marks.correct::after {
    background: var(--tile-text);
  }
  .marks.present::after {
    width: 4px;
    height: 4px;
    border: 1px solid var(--tile-text);
  }
  .node {
    font: 600 0.62rem var(--font-mono);
    padding: 2px 3px;
    border-radius: 3px;
  }
  .node.match {
    outline: 2px solid var(--accent);
  }
</style>
