<script lang="ts">
  // Owned by the panes agent: cover-flow target browser.
  // A strip across the top of the Tree view that flips through other targets'
  // trees in the same configuration. Data: the focused card run's games
  // grouped by target (R games per target), so no extra solver work is needed.
  import { onMount, tick } from 'svelte';
  import { focusTarget, setTargetOrder } from '../app/actions';
  import { app } from '../app/store.svelte';
  import { compileFilter } from '../model/filter';
  import { allTargets, syncTargets, targetIndex, targets } from './browser/targets.svelte';
  import { firstWithLetter, layoutThumb, sortTargets } from './browser/stats';
  import { drawThumb, THUMB_H, THUMB_W } from './browser/thumbs';
  import { gamesTouching } from './filter/builder';
  import { live, startLive } from './live.svelte';
  import { answerWord, isSpoiler } from './services';
  import { paneState, type TargetSort } from './state.svelte';
  import { attempt, clamp, fmtNum, fmtPct } from './util';

  const SIDE = 8;
  const GAP = 92; // centre to the first side cover (px)
  const SPACING = 44; // between side covers (px)
  const DRAG_PX = 60; // drag distance per cover
  const STRIP_H = 212;
  const PERSPECTIVE = 700; // px, as in the .stage style

  const SORTS: { value: TargetSort; label: string }[] = [
    { value: 'alpha', label: 'Alphabetical' },
    { value: 'mean', label: 'Mean guesses (hardest first)' },
    { value: 'fail', label: 'Fail rate' },
    { value: 'breadth', label: 'Tree breadth' },
    { value: 'random', label: 'Random' },
  ];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  const opacity = $derived(clamp(1 - Math.abs(app.z - 1) / 0.35, 0, 1));
  const shown = $derived(opacity > 0.02 && !!app.words && app.focus.target >= 0);
  const maxGuesses = $derived(app.result.maxGuesses);

  $effect(() => {
    void live.card;
    syncTargets();
  });

  /** The player's unsolved target (its word stays hidden), or -1. */
  const spoiler = $derived(app.game.board && app.game.board.status === 'playing' ? app.game.board.target : -1);

  const order = $derived.by(() => {
    void targets.version;
    void app.words;
    const o = sortTargets(allTargets(), targetIndex.byTarget, paneState.targetSort, paneState.randomSeed);
    // Alphabetical neighbours would give a hidden word away, so it goes first instead.
    if (paneState.targetSort === 'alpha' && spoiler >= 0) {
      const i = o.indexOf(spoiler);
      if (i > 0) {
        o.splice(i, 1);
        o.unshift(spoiler);
      }
    }
    return o;
  });

  // Publish the order: the platform's , and . shortcuts step through it.
  $effect(() => {
    paneState.targetOrder = order;
    attempt(() => setTargetOrder(spoiler >= 0 ? order.filter((t) => t !== spoiler) : order), undefined);
  });

  $effect(() => {
    paneState.occluded.top = shown ? STRIP_H : 0;
  });

  const centre = $derived(Math.max(0, order.indexOf(app.focus.target)));
  let drag = $state(0);
  let dragging = $state(false);

  const visible = $derived.by(() => {
    const lo = Math.max(0, centre - SIDE - 1);
    const hi = Math.min(order.length - 1, centre + SIDE + 1);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  });

  const filter = $derived(app.words ? compileFilter(app.filter, app.words.wordLength, app.display.yIsVowel) : null);

  function coverInfo(target: number) {
    void targets.version;
    const s = targetIndex.byTarget.get(target);
    const hidden = isSpoiler(target) || target === spoiler;
    const word = answerWord(target);
    let share = NaN;
    if (filter && s && app.words) {
      const { touching, total } = gamesTouching(s.games, app.words.guesses, filter);
      share = total ? touching / total : NaN;
    }
    return {
      label: hidden ? '?'.repeat(app.words?.wordLength ?? 5) : word.toUpperCase(),
      hidden,
      stats: s,
      share,
      key: `${targetIndex.runKey}|${target}|${s?.games.length ?? 0}`,
    };
  }

  function coverPose(i: number) {
    const k = i - centre - drag;
    const ak = Math.abs(k);
    const a = Math.min(1, ak);
    const sgn = Math.sign(k);
    const x = sgn * (a * GAP + Math.max(0, ak - 1) * SPACING);
    const rot = -sgn * 60 * a;
    const z = (1 - a) * 70 - Math.max(0, ak - 1) * 6;
    const fade = ak > SIDE ? Math.max(0, SIDE + 1 - ak) : 1;
    return { ak, x, rot, z, fade };
  }

  function coverStyle(i: number): string {
    const { ak, x, rot, z, fade } = coverPose(i);
    return `transform: translateX(${x.toFixed(1)}px) translateZ(${z.toFixed(1)}px) rotateY(${rot.toFixed(1)}deg); z-index: ${200 - Math.round(ak * 10)}; opacity: ${fade.toFixed(2)}`;
  }

  // Words sit in an unrotated row under the covers, at each cover's projected
  // centre, so neighbouring covers never hide them.
  function labelStyle(i: number): string {
    const { ak, x, z, fade } = coverPose(i);
    const sx = (x * PERSPECTIVE) / (PERSPECTIVE - z);
    const size = ak < 0.5 ? 0.78 : 0.6;
    return `transform: translateX(${sx.toFixed(1)}px) translateX(-50%); font-size: ${size}rem; opacity: ${fade.toFixed(2)}; z-index: ${200 - Math.round(ak * 10)}`;
  }

  function flipTo(index: number) {
    let i = clamp(Math.round(index), 0, order.length - 1);
    // The player's unsolved target is never opened (its tree would give the answer away).
    if (order[i] === spoiler) i = i >= centre ? i + 1 : i - 1;
    const t = order[i];
    if (t === undefined || t === spoiler || t === app.focus.target) return;
    // Already at the Tree view: the tree morphs in place.
    attempt(() => focusTarget(t, false), undefined);
  }

  function flip(delta: number) {
    flipTo(centre + delta);
  }

  // Thumbnails are drawn lazily, a few per frame, then cached by (run, target, games).
  const queue = new Map<HTMLCanvasElement, () => void>();
  let raf = 0;
  function pump() {
    raf = 0;
    const start = performance.now();
    for (const [canvas, job] of queue) {
      queue.delete(canvas);
      job();
      if (performance.now() - start > 6) break;
    }
    if (queue.size) raf = requestAnimationFrame(pump);
  }
  function schedule(canvas: HTMLCanvasElement, job: () => void) {
    queue.set(canvas, job);
    if (!raf) raf = requestAnimationFrame(pump);
  }

  function thumb(canvas: HTMLCanvasElement, params: { target: number; key: string }) {
    const run = (p: { target: number; key: string }) =>
      schedule(canvas, () =>
        drawThumb(canvas, p.key, maxGuesses, () => layoutThumb(targetIndex.byTarget.get(p.target)?.games ?? [], maxGuesses)),
      );
    run(params);
    return {
      update: run,
      destroy() {
        queue.delete(canvas);
      },
    };
  }

  // Dragging and swiping.
  let startX = 0;
  let moved = false;
  let down = false;
  let suppressClick = false;

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    down = true;
    moved = false;
    startX = e.clientX;
  }
  function onMove(e: PointerEvent) {
    if (!down) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 6) {
      moved = true;
      dragging = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (moved) drag = clamp(-dx / DRAG_PX, -centre - 0.4, order.length - 1 - centre + 0.4);
  }
  function onUp() {
    if (!down) return;
    down = false;
    if (moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      const to = centre + drag;
      dragging = false;
      drag = 0;
      flipTo(to);
    }
  }

  let wheelAcc = 0;
  function onWheel(e: WheelEvent) {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (!d) return;
    e.preventDefault();
    wheelAcc += d;
    if (Math.abs(wheelAcc) >= DRAG_PX) {
      flip(Math.sign(wheelAcc));
      wheelAcc = 0;
    }
  }

  function onCoverClick(i: number) {
    if (suppressClick) return;
    if (i === centre) return;
    flipTo(i);
  }

  let coversEl = $state<HTMLElement | null>(null);

  function onStripKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') flip(-1);
    else if (e.key === 'ArrowRight') flip(1);
    else if (e.key === 'Home') flipTo(0);
    else if (e.key === 'End') flipTo(order.length - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
    // Keep keyboard focus on the new centre cover.
    void tick().then(() => coversEl?.querySelector<HTMLElement>('.cover.centre')?.focus());
  }

  // A–Z scrubber (alphabetical order only).
  const centreLetter = $derived.by(() => {
    const t = order[centre];
    if (t === undefined || t === spoiler) return -1;
    const w = answerWord(t);
    return w ? w.charCodeAt(0) - 97 : -1;
  });
  let scrubLetter = $state(-1);

  function letterAt(e: PointerEvent): number {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    return clamp(Math.floor(((e.clientX - r.left) / r.width) * 26), 0, 25);
  }
  function jumpToLetter(l: number) {
    const i = firstWithLetter(order, answerWord, LETTERS[l]);
    if (i >= 0) flipTo(i);
  }
  function onScrubDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubLetter = letterAt(e);
  }
  function onScrubMove(e: PointerEvent) {
    if (scrubLetter >= 0) scrubLetter = letterAt(e);
  }
  function onScrubUp() {
    if (scrubLetter >= 0) jumpToLetter(scrubLetter);
    scrubLetter = -1;
  }
  function onScrubKey(e: KeyboardEvent) {
    const cur = centreLetter < 0 ? 0 : centreLetter;
    let l = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') l = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') l = Math.min(25, cur + 1);
    else if (e.key === 'Home') l = 0;
    else if (e.key === 'End') l = 25;
    else if (/^[a-z]$/i.test(e.key)) l = e.key.toLowerCase().charCodeAt(0) - 97;
    if (l < 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Skip letters no answer starts with, in the direction of travel.
    const dir = l < cur ? -1 : 1;
    for (let x = l; x >= 0 && x < 26; x += dir) {
      if (firstWithLetter(order, answerWord, LETTERS[x]) >= 0) {
        jumpToLetter(x);
        return;
      }
    }
  }

  const centreTarget = $derived(order[centre] ?? -1);
  const centreInfo = $derived(centreTarget >= 0 ? coverInfo(centreTarget) : null);

  onMount(() => {
    startLive();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      queue.clear();
    };
  });
</script>

{#if shown}
  <section
    class="browser"
    class:dragging
    style:opacity
    style:right="{paneState.phone ? 0 : paneState.occluded.right}px"
    style:height="{STRIP_H}px"
    aria-label="Target browser"
    aria-roledescription="carousel"
  >
    <div class="bar">
      <label class="sort">
        <span class="visually-hidden">Sort targets by</span>
        <select bind:value={paneState.targetSort} aria-label="Sort targets by">
          {#each SORTS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
        </select>
      </label>
      {#if paneState.targetSort === 'random'}
        <button type="button" class="small" onclick={() => paneState.randomSeed++}>Shuffle</button>
      {/if}
      {#if paneState.targetSort === 'alpha'}
        <div
          class="az"
          role="slider"
          tabindex="0"
          aria-label="Jump to letter"
          aria-valuemin={0}
          aria-valuemax={25}
          aria-valuenow={Math.max(0, centreLetter)}
          aria-valuetext={centreLetter >= 0 ? LETTERS[centreLetter] : 'hidden'}
          onpointerdown={onScrubDown}
          onpointermove={onScrubMove}
          onpointerup={onScrubUp}
          onpointercancel={() => (scrubLetter = -1)}
          onkeydown={onScrubKey}
        >
          {#each LETTERS as l, i (l)}
            <span class:on={(scrubLetter >= 0 ? scrubLetter : centreLetter) === i}>{l}</span>
          {/each}
        </div>
      {:else}
        <span class="spacer"></span>
      {/if}
      <span class="count" aria-live="polite">{centre + 1} / {order.length}</span>
    </div>

    <div class="stage-wrap">
      <button type="button" class="nav prev" onclick={() => flip(-1)} disabled={centre <= 0} aria-label="Previous target">‹</button>
      <!-- Drag and wheel surface; keyboard users flip with the arrow keys on the centre cover, or , and . -->
      <div
        class="stage"
        role="presentation"
        onpointerdown={onDown}
        onpointermove={onMove}
        onpointerup={onUp}
        onpointercancel={onUp}
        onwheel={onWheel}
      >
        <div class="covers" bind:this={coversEl}>
          {#each visible as i (order[i])}
            {@const t = order[i]}
            {@const info = coverInfo(t)}
            <button
              type="button"
              class="cover"
              class:centre={i === centre}
              style={coverStyle(i)}
              tabindex={i === centre ? 0 : -1}
              aria-current={i === centre ? 'true' : undefined}
              aria-keyshortcuts="ArrowLeft ArrowRight Home End"
              onkeydown={onStripKey}
              aria-label="{info.hidden ? 'Your current target (hidden)' : info.label}{info.stats
                ? `: mean ${fmtNum(info.stats.mean)} guesses, ${fmtPct(info.stats.failRate, 0)} not solved`
                : ''}"
              onclick={() => onCoverClick(i)}
            >
              <canvas use:thumb={{ target: t, key: info.key }} style:width="{THUMB_W}px" style:height="{THUMB_H}px" aria-hidden="true"></canvas>
              {#if filter && Number.isFinite(info.share)}
                <span class="match" aria-hidden="true"><span style:width="{info.share * 100}%"></span></span>
              {/if}
            </button>
          {/each}
        </div>
        <div class="words" aria-hidden="true">
          {#each visible as i (order[i])}
            {@const info = coverInfo(order[i])}
            <span class="word" class:hidden={info.hidden} class:centre={i === centre} style={labelStyle(i)}>{info.label}</span>
          {/each}
        </div>
      </div>
      <button type="button" class="nav next" onclick={() => flip(1)} disabled={centre >= order.length - 1} aria-label="Next target">›</button>
    </div>
    {#if centreInfo?.stats}
      <p class="visually-hidden" aria-live="polite">
        {centreInfo.hidden ? 'Your current target' : centreInfo.label}: mean {fmtNum(centreInfo.stats.mean)} guesses{filter && Number.isFinite(centreInfo.share)
          ? `, ${fmtPct(centreInfo.share, 0)} of games touch a filter match`
          : ''}
      </p>
    {/if}
  </section>
{/if}

<style>
  .browser {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 15;
    display: flex;
    flex-direction: column;
    background: linear-gradient(to bottom, var(--bg) 70%, transparent);
    pointer-events: auto;
    user-select: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 0;
    min-height: 44px;
  }
  select {
    min-height: 36px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    padding: 0 6px;
    font: inherit;
    font-size: 0.8rem;
  }
  .small {
    min-height: 36px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .az {
    flex: 1;
    min-width: 0;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font: 600 0.62rem var(--font-mono);
    color: var(--muted);
    cursor: pointer;
    touch-action: none;
    border-radius: 8px;
  }
  .az span {
    flex: 1;
    text-align: center;
  }
  .az span.on {
    color: var(--bg);
    background: var(--fg);
    border-radius: 3px;
  }
  .spacer {
    flex: 1;
  }
  .count {
    font-size: 0.75rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .stage-wrap {
    position: relative;
    flex: 1;
    display: flex;
    align-items: stretch;
    min-height: 0;
  }
  .stage {
    flex: 1;
    position: relative;
    overflow: hidden;
    perspective: 700px;
    touch-action: pan-y;
    cursor: grab;
  }
  .dragging .stage {
    cursor: grabbing;
  }
  .covers {
    position: absolute;
    left: 50%;
    top: 6px;
    width: 0;
    height: 100%;
    transform-style: preserve-3d;
  }
  .cover {
    position: absolute;
    left: -52px;
    top: 0;
    width: 104px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: var(--fg);
    cursor: pointer;
    transition:
      transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 0.35s linear;
    backface-visibility: hidden;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
  }
  .dragging .cover,
  :global(.reduced-motion) .cover {
    transition: none;
  }
  .cover.centre {
    border-color: var(--fg);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
  }
  canvas {
    display: block;
    border-radius: 4px;
    background: var(--bg);
  }
  .words {
    position: absolute;
    left: 50%;
    bottom: 2px;
    width: 0;
    height: 18px;
    pointer-events: none;
  }
  .word {
    position: absolute;
    left: 0;
    bottom: 0;
    padding: 0 3px;
    border-radius: 4px;
    background: var(--bg);
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.06em;
    line-height: 1.4;
    white-space: nowrap;
    color: var(--muted);
    transition:
      transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 0.35s linear;
  }
  .word.centre {
    color: var(--fg);
  }
  .dragging .word,
  :global(.reduced-motion) .word {
    transition: none;
  }
  .word.hidden {
    color: var(--muted);
  }
  .match {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    overflow: hidden;
  }
  .match span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .nav {
    flex: none;
    width: 44px;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-size: 1.8rem;
    cursor: pointer;
    z-index: 300;
  }
  .nav:disabled {
    opacity: 0.25;
    cursor: default;
  }
  button:focus-visible,
  select:focus-visible,
  .stage:focus-visible,
  .az:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }
</style>
