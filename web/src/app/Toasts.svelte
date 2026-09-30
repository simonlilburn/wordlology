<script lang="ts">
  // Owned by the platform agent: toasts (app.ui.toasts, pushed by actions.toast).
  import { dismissToast } from './actions';
  import { app } from './store.svelte';
</script>

<div class="toasts" role="status" aria-live="polite" aria-atomic="false">
  {#each app.ui.toasts as t (t.id)}
    <div class="toast" class:error={t.kind === 'error'} role={t.kind === 'error' ? 'alert' : undefined}>
      <span class="text">{t.text}</span>
      <button type="button" class="close" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: max(16px, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    z-index: 1000;
    pointer-events: none;
    width: min(92vw, 480px);
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--fg);
    color: var(--bg);
    border-radius: 8px;
    padding: 8px 8px 8px 14px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
    font-size: 14px;
    line-height: 1.35;
    animation: in 160ms ease-out;
  }
  .toast.error {
    background: #b3261e;
    color: #fff;
  }
  .text {
    flex: 1;
  }
  .close {
    min-width: 44px;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 20px;
    cursor: pointer;
    border-radius: 6px;
  }
  .close:focus-visible {
    outline: 2px solid var(--accent);
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  :global(.reduced-motion) .toast {
    animation: none;
  }
</style>
