<script lang="ts">
  // The wordmark: "wordl" as a row of feedback tiles, then "ology". One image
  // to assistive technology ("wordlology"). With `flip`, the tiles turn over
  // one after another when it first appears (not under reduced motion).
  import { app } from './store.svelte';

  let { size = '1.25rem', flip = false }: { size?: string; flip?: boolean } = $props();

  // Feedback of each tile: absent, present, correct, absent, correct.
  const TILES: [string, 'a' | 'y' | 'g'][] = [
    ['w', 'a'],
    ['o', 'y'],
    ['r', 'g'],
    ['d', 'a'],
    ['l', 'g'],
  ];
</script>

<span class="wordmark" class:flip={flip && !app.reducedMotion} style:font-size={size} role="img" aria-label="wordlology">
  {#each TILES as [ch, kind], i (i)}<span class="t {kind}" style:--i={i} aria-hidden="true">{ch}</span>{/each}<span
    class="rest"
    aria-hidden="true">ology</span
  >
</span>

<style>
  .wordmark {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-display);
    font-weight: 800;
    font-stretch: 85%;
    letter-spacing: -0.035em;
    line-height: 1;
    white-space: nowrap;
    color: var(--fg);
  }
  .t {
    display: inline-grid;
    place-items: center;
    width: 1.04em;
    height: 1.1em;
    margin-right: 0.06em;
    border-radius: 0.14em;
    color: var(--tile-text);
    font-size: 0.82em;
    letter-spacing: 0;
    text-transform: uppercase;
    box-shadow: inset 0 -0.09em 0 rgb(0 0 0 / 0.2);
  }
  .t:nth-child(5) {
    margin-right: 0.14em;
  }
  .t.g {
    background: var(--correct);
  }
  .t.y {
    background: var(--present);
  }
  .t.a {
    background: var(--absent);
  }
  :global([data-theme='dark']) .t.a {
    background: #5a5d5f;
  }
  .flip .t {
    animation: flip 520ms ease-in-out calc(var(--i) * 140ms + 150ms) both;
  }
  @keyframes flip {
    0% {
      transform: rotateX(0);
      background: transparent;
      color: var(--fg);
      box-shadow: inset 0 0 0 2px var(--line);
    }
    49% {
      background: transparent;
      color: var(--fg);
      box-shadow: inset 0 0 0 2px var(--line);
    }
    50% {
      transform: rotateX(90deg);
    }
    100% {
      transform: rotateX(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flip .t {
      animation: none;
    }
  }
</style>
