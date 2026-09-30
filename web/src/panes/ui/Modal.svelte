<script lang="ts">
  // A modal dialog for the panes' dialogs: focus moves in on open and back on
  // close, Esc and the backdrop close it, and Tab stays inside.
  import { onMount, type Snippet } from 'svelte';

  let {
    title,
    onclose,
    width = 480,
    children,
    labelledby,
  }: { title: string; onclose: () => void; width?: number; children: Snippet; labelledby?: string } = $props();

  let box = $state<HTMLElement | null>(null);
  const id = `modal-${Math.random().toString(36).slice(2, 8)}`;

  function focusables(): HTMLElement[] {
    if (!box) return [];
    return [...box.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    );
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Keep global shortcuts (letters, , . - =) from firing while the dialog is open.
    if (e.key.length === 1 || e.key === 'Escape') e.stopPropagation();
  }

  onMount(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    first?.focus();
    return () => before?.focus?.();
  });
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div
    bind:this={box}
    class="box"
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledby ?? id}
    style:max-width="{width}px"
    tabindex="-1"
    onkeydown={onKey}
  >
    <header>
      <h2 id={id}>{title}</h2>
      <button type="button" class="close" onclick={onclose} aria-label="Close">×</button>
    </header>
    <div class="body">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgb(0 0 0 / 0.35);
  }
  .box {
    width: 100%;
    max-height: min(86vh, 760px);
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.3);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .close {
    width: 44px;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-size: 1.5rem;
    cursor: pointer;
    border-radius: 8px;
  }
  .close:focus-visible {
    outline: 3px solid var(--accent);
  }
  .body {
    padding: 12px 16px 16px;
    overflow-y: auto;
    min-height: 0;
  }
</style>
