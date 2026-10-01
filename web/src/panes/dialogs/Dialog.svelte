<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  // Accessible modal dialog: a native <dialog> opened with showModal (the rest
  // of the page becomes inert), labelled by its title, focus kept inside,
  // Esc and the backdrop close it, focus returns to the opener. Full-screen
  // sheet on phones.
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    title: string;
    onclose: () => void;
    /** Width on larger screens. */
    size?: 'sm' | 'md' | 'lg';
    /** Optional subtitle under the title. */
    subtitle?: string;
    children: Snippet;
    footer?: Snippet;
    /** Extra controls in the header, before the close button. */
    headerExtra?: Snippet;
    /** Where focus goes on open: the first control in the body (forms), or the close button (text to read). */
    initialFocus?: 'body' | 'close';
  }

  let { open, title, onclose, size = 'md', subtitle, children, footer, headerExtra, initialFocus = 'body' }: Props = $props();

  const id = `dlg-${nextId++}`;
  let el: HTMLDialogElement | undefined = $state();
  let opener: HTMLElement | null = null;

  // A body that scrolls takes keyboard focus, so it can be scrolled without a pointer (WCAG 2.1.1).
  let bodyEl: HTMLElement | undefined = $state();
  let scrollable = $state(false);
  $effect(() => {
    const b = bodyEl;
    if (!b || typeof ResizeObserver === 'undefined') return;
    const check = () => (scrollable = b.scrollHeight > b.clientHeight + 1);
    const ro = new ResizeObserver(check);
    ro.observe(b);
    for (const c of b.children) ro.observe(c);
    check();
    return () => ro.disconnect();
  });

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(): HTMLElement[] {
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  $effect(() => {
    const d = el;
    if (!d) return;
    if (open && !d.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
      // Focus the first control in the body (not the close button) once rendered.
      queueMicrotask(() => {
        const body = d.querySelector<HTMLElement>('[data-dialog-body]');
        const first = initialFocus === 'body' ? body?.querySelector<HTMLElement>('[autofocus], ' + FOCUSABLE) : null;
        (first ?? d.querySelector<HTMLElement>('[data-dialog-close]'))?.focus({ preventScroll: true });
      });
    } else if (!open && d.open) {
      try {
        d.close();
      } catch {
        d.removeAttribute('open');
      }
      if (opener && opener.isConnected) opener.focus();
      opener = null;
    }
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    if (e.key === 'Tab') {
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Global shortcuts stay quiet while a dialog is open.
    e.stopPropagation();
  }

  function oncancel(e: Event) {
    e.preventDefault();
    onclose();
  }

  function onclick(e: MouseEvent) {
    // A click on the dialog element itself is a click on the backdrop.
    if (e.target === el) onclose();
  }
</script>

<dialog
  bind:this={el}
  class="dlg {size}"
  aria-labelledby="{id}-title"
  aria-describedby={subtitle ? `${id}-sub` : undefined}
  {onkeydown}
  {oncancel}
  {onclick}
>
  {#if open}
    <div class="inner">
      <header>
        <div class="titles">
          <h2 id="{id}-title">{title}</h2>
          {#if subtitle}<p id="{id}-sub" class="sub">{subtitle}</p>{/if}
        </div>
        {#if headerExtra}{@render headerExtra()}{/if}
        <button class="close" data-dialog-close type="button" aria-label="Close" onclick={onclose}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
            ><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg
          >
        </button>
      </header>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="body"
        data-dialog-body
        bind:this={bodyEl}
        role={scrollable ? 'region' : undefined}
        aria-labelledby={scrollable ? `${id}-title` : undefined}
        tabindex={scrollable ? 0 : undefined}
      >
        {@render children()}
      </div>
      {#if footer}
        <footer>{@render footer()}</footer>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .dlg {
    --w: 560px;
    border: none;
    padding: 0;
    margin: auto;
    border-radius: 14px;
    background: var(--bg);
    color: var(--fg);
    width: min(calc(100vw - 32px), var(--w));
    max-width: none;
    max-height: min(calc(100dvh - 48px), 920px);
    box-shadow:
      0 24px 64px rgb(0 0 0 / 0.28),
      0 0 0 1px var(--line);
    overflow: hidden;
  }
  .dlg.sm {
    --w: 420px;
  }
  .dlg.lg {
    --w: 760px;
  }
  .dlg[open] {
    display: flex;
    animation: dlg-in 160ms ease-out;
  }
  .dlg::backdrop {
    background: rgb(0 0 0 / 0.45);
  }
  :global(.reduced-motion) .dlg[open] {
    animation: none;
  }
  @keyframes dlg-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
  }
  .inner {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: inherit;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 10px 20px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .sub {
    margin: 2px 0 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .close {
    flex: none;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }
  .close:hover {
    background: var(--panel);
  }
  .close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .body:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 16px 20px 20px;
    touch-action: pan-y;
  }
  footer {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }

  /* Phones: a full-screen sheet. */
  @media (max-width: 600px) {
    .dlg,
    .dlg.sm,
    .dlg.lg {
      width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      margin: 0;
      border-radius: 0;
      box-shadow: none;
    }
    .dlg[open] {
      animation: sheet-in 200ms ease-out;
    }
    :global(.reduced-motion) .dlg[open] {
      animation: none;
    }
    .inner {
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
  @keyframes sheet-in {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
</style>
