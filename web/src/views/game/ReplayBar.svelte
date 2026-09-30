<script lang="ts">
  // Replay controls under the board: a scrubber with one stop per turn, the
  // Next button, the hint chip and the annotations toggle.
  import { app } from '../../app/store.svelte';
  import { fmtProb } from './candidates';
  import { endedAt } from './replay';
  import { solvedCode } from './logic';
  import { replayConfig, strategyLabel } from './services';
  import { currentPath, maxGuesses, next, pathKey, playHint, scrub, view, wordLength, wordOf } from './state.svelte';

  const n = $derived(app.replay.guesses.length);
  const cursor = $derived(app.replay.cursor);
  const stops = $derived(Array.from({ length: n + 1 }, (_, i) => i));
  const ended = $derived(endedAt(currentPath(), cursor, solvedCode(wordLength()), maxGuesses()));
  const nextKind = $derived(ended ? 'none' : cursor < n ? 'path' : 'draw');
  const label = $derived(strategyLabel(replayConfig()));
  const hintReady = $derived(view.hint !== null && view.hint.key === `${pathKey()}@${cursor}`);
  const valueText = $derived(
    cursor === 0 ? `Start, before guess 1 of ${n}` : `After guess ${cursor} of ${n}, ${wordOf(app.replay.guesses[cursor - 1]).toUpperCase()}`,
  );

  let track: HTMLDivElement | undefined = $state();
  let dragging = false;

  function stopAt(clientX: number): number {
    if (!track || n === 0) return 0;
    const r = track.getBoundingClientRect();
    const t = (clientX - r.left) / Math.max(1, r.width);
    return Math.round(Math.max(0, Math.min(1, t)) * n);
  }
  function ondown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    track?.setPointerCapture(e.pointerId);
    track?.focus();
    scrub(stopAt(e.clientX));
  }
  function onmove(e: PointerEvent) {
    if (dragging) scrub(stopAt(e.clientX));
  }
  function onup(e: PointerEvent) {
    dragging = false;
    if (track?.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
  }
  function onkeydown(e: KeyboardEvent) {
    let to: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = cursor - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = cursor + 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    scrub(to);
  }
</script>

<div class="replay" role="group" aria-label="Replay controls">
  <div class="caption">
    <span class="badge">Replay</span>
    <span class="who" title={label}>{label}</span>
    {#if view.branchAt >= 0}<span class="branch">your branch from guess {view.branchAt + 1}</span>{/if}
  </div>

  <div
    class="track"
    bind:this={track}
    role="slider"
    tabindex="0"
    aria-label="Replay position"
    aria-valuemin={0}
    aria-valuemax={n}
    aria-valuenow={cursor}
    aria-valuetext={valueText}
    style="--n: {Math.max(1, n)}"
    onpointerdown={ondown}
    onpointermove={onmove}
    onpointerup={onup}
    onpointercancel={onup}
    {onkeydown}
  >
    <div class="rail"><div class="fill" style="width: {n ? (cursor / n) * 100 : 0}%"></div></div>
    {#each stops as s (s)}
      <span class="stop" class:on={s <= cursor} class:at={s === cursor} style="left: {n ? (s / n) * 100 : 0}%" aria-hidden="true">
        <span class="lbl">{s === 0 ? '0' : s}</span>
      </span>
    {/each}
  </div>

  <div class="actions">
    {#if hintReady && view.hint}
      <button
        type="button"
        class="chip"
        onclick={playHint}
        disabled={ended !== null || view.drawing}
        title="The strategy's most likely next guess; tap to play it"
        aria-label="Hint: the strategy would play {wordOf(view.hint.word).toUpperCase()}{view.hint.deterministic
          ? ''
          : ` with probability ${fmtProb(view.hint.p)}`}. Play it"
      >
        <span class="chip-k">Strategy</span>
        <span class="chip-w">{wordOf(view.hint.word)}</span>
        <span class="chip-p">{view.hint.deterministic ? 'top' : fmtProb(view.hint.p)}</span>
      </button>
    {:else if view.hintState === 'loading' && !ended}
      <span class="chip ghost" aria-hidden="true"><span class="chip-k">Strategy</span><span class="chip-w">·····</span></span>
    {/if}
    <span class="spacer"></span>
    <button
      type="button"
      class="toggle"
      aria-pressed={app.display.replayAnnotations}
      onclick={() => (app.display.replayAnnotations = !app.display.replayAnnotations)}
      title="Show candidates, bits, probability and phase beside each row"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
        ><path d="M4 6h10M4 12h10M4 18h10M17 6h3M17 12h3M17 18h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg
      >
      <span>Notes</span>
    </button>
    <button
      type="button"
      class="next"
      onclick={() => void next()}
      disabled={nextKind === 'none' || view.drawing}
      title={nextKind === 'path' ? "Play the path's next guess" : nextKind === 'draw' ? "Draw the strategy's next guess" : 'The game is over'}
    >
      {view.drawing ? 'Drawing…' : 'Next'}
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
        ><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg
      >
    </button>
  </div>
</div>

<style>
  .replay {
    width: min(100%, 460px);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85rem;
  }
  .caption {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--muted);
    white-space: nowrap;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .who {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .branch {
    color: var(--accent);
  }
  .track {
    position: relative;
    height: 34px;
    margin: 0 12px;
    cursor: pointer;
    touch-action: none;
    border-radius: 8px;
  }
  .track:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 6px;
  }
  .rail {
    position: absolute;
    left: 0;
    right: 0;
    top: 10px;
    height: 4px;
    border-radius: 2px;
    background: var(--line);
  }
  .fill {
    height: 100%;
    border-radius: 2px;
    background: var(--accent);
  }
  .stop {
    position: absolute;
    top: 6px;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid var(--line);
    box-sizing: border-box;
  }
  .stop.on {
    border-color: var(--accent);
    background: var(--accent);
  }
  .stop.at {
    width: 20px;
    height: 20px;
    margin-left: -10px;
    top: 2px;
    background: var(--bg);
    border: 5px solid var(--accent);
  }
  .lbl {
    position: absolute;
    top: 15px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 0.68rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .stop.at .lbl {
    top: 17px;
    color: var(--fg);
    font-weight: 700;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  button {
    min-height: 44px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    font-weight: 600;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .toggle[aria-pressed='true'] {
    background: var(--panel);
    border-color: var(--accent);
    color: var(--accent);
  }
  .next {
    background: var(--fg);
    color: var(--bg);
    border-color: var(--fg);
  }
  .chip {
    padding: 0 12px 0 6px;
    gap: 6px;
    background: var(--panel);
  }
  .chip.ghost {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    border-radius: 999px;
    border: 1px dashed var(--line);
    opacity: 0.6;
  }
  .chip-k {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--bg);
  }
  .chip-w {
    font-family: var(--font-mono);
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .chip-p {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 380px) {
    .toggle span {
      display: none;
    }
  }
</style>
