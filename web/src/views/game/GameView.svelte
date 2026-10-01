<script lang="ts">
  // Level 0, the Game view: header, board, replay controls and keyboard.
  // Visible while the zoom value z is near 0; the DOM board hides once the
  // scene's Game → Tree transition takes over (z > 0.05), and the rest fades
  // out as z approaches 1.
  import { onMount, untrack } from 'svelte';
  import { app } from '../../app/store.svelte';
  import { setLevel } from '../../app/actions';
  import { registerShortcut } from '../../app/keyboard';
  import { endZoomGesture, zoomBy, zoomByWheel } from '../../app/zoom';
  import { keyFromEvent } from './logic';
  import { attempt } from './services';
  import {
    anyDialogOpen,
    ensureBoard,
    fillTurnScores,
    gameActive,
    inReplay,
    loadHint,
    pathKey,
    press,
    recordBranch,
    startNewGame,
    step,
    syncReplay,
    syncWords,
    view,
  } from './state.svelte';
  import Board from './Board.svelte';
  import Keyboard from './Keyboard.svelte';
  import ReplayBar from './ReplayBar.svelte';
  import CandidateList from './CandidateList.svelte';
  import Wordmark from '../../app/Wordmark.svelte';
  import { paneState } from '../../panes/state.svelte';

  const z = $derived(Math.max(0, app.z));
  const active = $derived(gameActive());
  const boardShown = $derived(z <= 0.05);
  const fade = $derived(Math.max(0, 1 - z * 2));
  const hidden = $derived(z >= 0.999 && app.zTarget !== 0);
  const replay = $derived(inReplay());
  const phone = $derived(paneState.phone);

  let areaW = $state(0);
  let areaH = $state(0);
  let root: HTMLElement | undefined = $state();

  // A board once the word list is loaded (the platform's init normally makes one).
  $effect(() => {
    if (!app.words || app.game.board) return;
    const t = setTimeout(() => ensureBoard(), 250);
    return () => clearTimeout(t);
  });

  // A rebuilt word list (new answer selection) keeps the board's target by word.
  $effect(() => {
    void app.words;
    void app.game.board;
    void app.game.board?.target;
    void app.replay.active;
    void app.replay.target;
    untrack(() => syncWords());
  });

  // New replay path opened from a higher level.
  $effect(() => {
    void app.replay.active;
    void app.replay.target;
    void app.replay.guesses;
    untrack(() => syncReplay());
  });

  // A replay branch left unfinished is still recorded, so the tree overlays it.
  let wasActive = true;
  $effect(() => {
    const a = active;
    untrack(() => {
      if (wasActive && !a) recordBranch();
      wasActive = a;
    });
  });

  // Hint chip for the state at the replay cursor.
  $effect(() => {
    if (!replay || !active || !app.words || !app.solverReady) return;
    void pathKey();
    void app.replay.cursor;
    const ctrl = new AbortController();
    const t = setTimeout(() => void untrack(() => loadHint(ctrl.signal)), 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  });

  // Strategy probabilities for player turns in the annotation column.
  $effect(() => {
    if (!replay || !app.display.replayAnnotations || !app.solverReady) return;
    void pathKey();
    const ctrl = new AbortController();
    const t = setTimeout(() => void untrack(() => fillTurnScores(ctrl.signal)), 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  });

  onMount(() => {
    const when = () => gameActive() && inReplay() && !anyDialogOpen();
    const offs = [
      registerShortcut({ keys: ['ArrowLeft'], description: 'Replay: previous turn', when, handler: () => step(-1) }),
      registerShortcut({ keys: ['ArrowRight'], description: 'Replay: next turn', when, handler: () => step(1) }),
    ];
    return () => offs.forEach((off) => off());
  });

  function isEditable(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
  }

  // Physical keyboard: letters, Enter and Backspace, only while the Game view is active.
  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!gameActive() || anyDialogOpen() || isEditable(e.target)) return;
    const key = keyFromEvent(e.key);
    if (!key) return;
    // Enter on a button the user tabbed to activates it (buttons here never take
    // focus from a mouse click, so after a click Enter still plays the row).
    if (key.kind === 'enter' && e.target instanceof HTMLElement && e.target.closest('button, a[href], summary')) return;
    e.preventDefault();
    if (e.repeat && key.kind === 'enter') return;
    press(key);
  }

  // Scroll and pinch over the board zoom out towards the Tree view.
  onMount(() => {
    const el = root;
    if (!el) return;
    const scrollable = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-scroll], dialog');
    const onwheel = (e: WheelEvent) => {
      if (!gameActive() || anyDialogOpen() || scrollable(e.target)) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit;
      if (dy <= 0 && app.z <= 0) return; // nothing further in than the board
      e.preventDefault();
      attempt(() => zoomByWheel(dy * (e.ctrlKey ? 0.01 : 0.0025)), undefined);
    };
    let pinchStart = 0;
    let pinchLast = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const ontouchstart = (e: TouchEvent) => {
      if (e.touches.length === 2 && gameActive() && !anyDialogOpen()) {
        pinchStart = dist(e.touches);
        pinchLast = 0;
      }
    };
    const ontouchmove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinchStart <= 0) return;
      e.preventDefault();
      // Fingers closing (pinch in) zoom out: one level per halving of the distance.
      const dz = Math.log2(pinchStart / Math.max(1, dist(e.touches)));
      attempt(() => zoomBy(dz - pinchLast), undefined);
      pinchLast = dz;
    };
    const ontouchend = (e: TouchEvent) => {
      if (pinchStart > 0 && e.touches.length < 2) {
        pinchStart = 0;
        attempt(() => endZoomGesture(), undefined);
      }
    };
    // Buttons keep focus off themselves on a mouse click, so Enter keeps playing the board.
    const onmousedown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('button')) e.preventDefault();
    };
    el.addEventListener('mousedown', onmousedown);
    el.addEventListener('wheel', onwheel, { passive: false });
    el.addEventListener('touchstart', ontouchstart, { passive: true });
    el.addEventListener('touchmove', ontouchmove, { passive: false });
    el.addEventListener('touchend', ontouchend);
    el.addEventListener('touchcancel', ontouchend);
    return () => {
      el.removeEventListener('mousedown', onmousedown);
      el.removeEventListener('wheel', onwheel);
      el.removeEventListener('touchstart', ontouchstart);
      el.removeEventListener('touchmove', ontouchmove);
      el.removeEventListener('touchend', ontouchend);
      el.removeEventListener('touchcancel', ontouchend);
    };
  });
</script>

{#snippet bar()}
  <header class="bar" class:bottom={phone}>
    <h1 class="wordmark">
      <button type="button" class="wordmark-btn" onclick={() => (app.ui.about = true)} title="About wordlology">
        <Wordmark size={phone ? '1.15rem' : '1.4rem'} flip /><span class="visually-hidden">, about</span>
      </button>
    </h1>
    <nav class="tools" aria-label="Game">
      <button type="button" class="tool text" onclick={startNewGame} title="Start a game with a new random word">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
          ><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg
        >
        <span class="lab">New game</span>
      </button>
      <button
        type="button"
        class="tool text"
        onclick={() => attempt(() => setLevel(1), undefined)}
        title="Zoom out to the Tree view (−)"
        aria-label="Zoom out to the Tree view"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
          ><path
            d="M12 4v5M12 9l-5 5M12 9l5 5M7 14v4M17 14v4M12 9v9"
            stroke="currentColor"
            stroke-width="2"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          /></svg
        >
        <span class="lab">Tree</span>
      </button>
      <button type="button" class="tool" onclick={() => (app.ui.settings = true)} aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
          ><path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.4h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z"
            stroke="currentColor"
            stroke-width="1.8"
            fill="none"
            stroke-linejoin="round"
          /></svg
        >
      </button>
      <button type="button" class="tool" onclick={() => (app.ui.help = true)} aria-label="Help and shortcuts" title="Help (?)">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
          ><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none" /><path
            d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6"
            stroke="currentColor"
            stroke-width="1.8"
            fill="none"
            stroke-linecap="round"
          /><circle cx="12" cy="17" r="1.1" fill="currentColor" /></svg
        >
      </button>
    </nav>
  </header>
{/snippet}

<svelte:window {onkeydown} />

<section
  class="game"
  bind:this={root}
  class:hidden
  class:inactive={!active}
  class:replay
  class:phone
  class:opaque={boardShown}
  style="--fade: {fade}; --z: {z}"
  inert={!active}
  aria-hidden={!active}
  aria-label="Game"
>
  {#if !phone}{@render bar()}{/if}

  <div class="area" bind:clientWidth={areaW} bind:clientHeight={areaH} style="--area-w: {areaW}px; --area-h: {areaH}px">
    {#if app.game.message}
      <div class="message" aria-hidden="true">{app.game.message}</div>
    {/if}
    {#if app.loadError}
      <div class="notice" role="alert">
        <strong>The word list could not be loaded.</strong>
        <span>{app.loadError}</span>
      </div>
    {:else}
      <div class="board-holder" class:gone={!boardShown} class:loading={!app.words}>
        <Board />
      </div>
      {#if !app.words}<p class="loading-text">Loading the word list…</p>{/if}
    {/if}
  </div>

  {#if replay}
    <div class="replay-holder">
      <ReplayBar />
    </div>
  {/if}

  <div class="kb-holder">
    <Keyboard />
  </div>

  <!-- Phones: the heading sits under the keyboard, within thumb reach (and after it in reading order). -->
  {#if phone}{@render bar()}{/if}

  <div class="visually-hidden" aria-live="polite" aria-atomic="true">{view.announcement}</div>
</section>

<CandidateList />

<style>
  .game {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) max(8px, env(safe-area-inset-bottom)) env(safe-area-inset-left);
    box-sizing: border-box;
    background: transparent;
    touch-action: none;
    z-index: 5;
    --key-h: clamp(44px, 7.2dvh, 58px);
  }
  .game.phone {
    padding-top: max(10px, env(safe-area-inset-top));
    padding-bottom: env(safe-area-inset-bottom);
  }
  .game.opaque {
    background: var(--bg);
  }
  .game.inactive {
    pointer-events: none;
  }
  .game.hidden {
    visibility: hidden;
  }

  .bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 56px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--line);
    opacity: var(--fade);
    transform: translateY(calc(var(--z) * -40px));
  }
  .bar.bottom {
    margin-top: 6px;
    border-bottom: 0;
    border-top: 1px solid var(--line);
    transform: translateY(calc(var(--z) * 60px));
  }
  .wordmark {
    margin: 0;
    font-size: inherit;
    line-height: 1;
  }
  .wordmark-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 4px;
    margin-left: -4px;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }
  .wordmark-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tool {
    min-width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 10px;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font-weight: 700;
    font-size: 0.9rem;
  }
  .tool:hover {
    background: var(--panel);
  }
  .tool:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @media (max-width: 420px) {
    .tool.text .lab {
      display: none;
    }
    .bar {
      padding-left: 12px;
    }
  }

  .area {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 8px 8px;
    box-sizing: border-box;
  }
  .board-holder.gone {
    opacity: 0;
  }
  .board-holder.loading {
    opacity: 0.5;
  }
  .loading-text {
    margin: 12px 0 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .notice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 28rem;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    text-align: center;
  }
  .message {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
    max-width: calc(100% - 32px);
    padding: 10px 16px;
    border-radius: 8px;
    background: var(--fg);
    color: var(--bg);
    font-weight: 700;
    font-size: 0.95rem;
    text-align: center;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.2);
    pointer-events: none;
    opacity: var(--fade);
  }

  .replay-holder {
    flex: none;
    padding: 6px 12px 4px;
    opacity: var(--fade);
  }
  .kb-holder {
    flex: none;
    padding: 6px 0 0;
    opacity: var(--fade);
    transform: translateY(calc(var(--z) * 160px));
  }
</style>
