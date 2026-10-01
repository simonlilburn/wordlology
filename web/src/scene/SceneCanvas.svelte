<script lang="ts">
  // Owned by the scene/tree agent: mounts the three.js scene on one full-window
  // canvas, once. The scene is a plain TypeScript module; Svelte never
  // re-renders it (this component has no reactive markup).
  import { onMount } from 'svelte';
  import { createScene } from './index';

  let canvas: HTMLCanvasElement | undefined = $state();
  let failed = $state(false);

  onMount(() => {
    if (!canvas) return;
    try {
      const api = createScene(canvas);
      return () => api.dispose();
    } catch (e) {
      console.error('[scene] WebGL is not available', e);
      failed = true;
    }
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
