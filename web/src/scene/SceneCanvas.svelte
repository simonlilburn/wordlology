<script lang="ts">
  // Owned by the scene/tree agent: mounts the three.js scene on one full-window
  // canvas, once. The scene is a plain TypeScript module; Svelte never
  // re-renders it (this component has no reactive markup).
  import { onMount } from 'svelte';
  import { fontsReady } from '../app/fonts';
  import { createScene } from './index';

  let canvas: HTMLCanvasElement | undefined = $state();
  let failed = $state(false);

  // The scene starts once the typefaces are in (or a short timeout passes), so
  // its canvas text never bakes in a fallback font.
  onMount(() => {
    let api: { dispose(): void } | null = null;
    let gone = false;
    void fontsReady().then(() => {
      if (gone || !canvas) return;
      try {
        api = createScene(canvas);
      } catch (e) {
        console.error('[scene] WebGL is not available', e);
        failed = true;
      }
    });
    return () => {
      gone = true;
      api?.dispose();
    };
  });
</script>

<canvas bind:this={canvas} class="scene" aria-hidden="true" data-scene></canvas>
{#if failed}
  <p class="nogl" role="status">This browser could not start WebGL, so the tree, card and atlas pictures are unavailable. Their text alternatives still work.</p>
{/if}

<style>
  .scene {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    outline: none;
    z-index: 0;
  }
  .nogl {
    position: absolute;
    left: 50%;
    top: 40%;
    transform: translateX(-50%);
    max-width: 28rem;
    margin: 0;
    color: var(--muted);
    text-align: center;
    font-size: 0.9rem;
    pointer-events: none;
  }
</style>
