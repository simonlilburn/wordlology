<script lang="ts">
  // Hybrid builder: an ordered list of phases, each played until its switch
  // rule fires, reorderable by drag (or the move buttons and arrow keys on the
  // handle). Compiled to nested `switch` specs (lab.ts compilePhases).
  import { tick, untrack } from 'svelte';
  import type { StrategySchema, StrategySpec, SwitchRule } from '../backend/types';
  import SpecEditor from './SpecEditor.svelte';
  import SwitchRuleEditor from './fields/SwitchRuleEditor.svelte';
  import { compilePhases, decompilePhases, DEFAULT_SWITCH_RULE, defaultSpec, describeRule, movePhase, type Issue, type Phase } from './lab';

  let {
    spec,
    onchange,
    schemas,
    issues = [],
    freq = true,
    maxGuesses = 6,
  }: {
    spec: StrategySpec;
    onchange: (next: StrategySpec) => void;
    schemas: StrategySchema[];
    issues?: Issue[];
    freq?: boolean;
    maxGuesses?: number;
  } = $props();

  let phases = $state<Phase[]>(untrack(() => decompilePhases(spec)));
  let items: HTMLElement[] = $state([]);
  let handles: HTMLElement[] = $state([]);
  let drag = $state<{ from: number; over: number; dy: number } | null>(null);
  let startY = 0;
  let live = $state('');

  /** Issue paths of phase i in the compiled spec. */
  function specPath(i: number): string {
    const n = phases.length;
    const prefix = 'then.'.repeat(i);
    return i < n - 1 ? `${prefix}first` : prefix.slice(0, -1);
  }
  function rulePath(i: number): string {
    return `${'then.'.repeat(i)}when`;
  }

  function emit(next: Phase[]) {
    phases = next;
    onchange(compilePhases(next));
  }

  function setSpec(i: number, s: StrategySpec) {
    emit(phases.map((p, j) => (j === i ? { ...p, spec: s } : p)));
  }

  function setRule(i: number, r: SwitchRule) {
    emit(phases.map((p, j) => (j === i ? { ...p, when: r } : p)));
  }

  function add() {
    const next = phases.map((p, j) => (j === phases.length - 1 ? { ...p, when: p.when ?? { ...DEFAULT_SWITCH_RULE } } : p));
    next.push({ spec: defaultSpec('max_info', schemas), when: null });
    emit(next);
    live = `Added phase ${next.length}.`;
  }

  function remove(i: number) {
    if (phases.length <= 1) return;
    const next = phases.filter((_, j) => j !== i).map((p, j, arr) => ({ ...p, when: j === arr.length - 1 ? null : (p.when ?? { ...DEFAULT_SWITCH_RULE }) }));
    emit(next);
    live = `Removed phase ${i + 1}.`;
  }

  async function move(from: number, to: number, refocus = true) {
    if (to < 0 || to >= phases.length || from === to) return;
    emit(movePhase(phases, from, to));
    live = `Moved phase ${from + 1} to position ${to + 1}.`;
    if (refocus) {
      await tick();
      handles[to]?.focus();
    }
  }

  function onHandleKey(e: KeyboardEvent, i: number) {
    if (e.key === 'ArrowUp') void move(i, i - 1);
    else if (e.key === 'ArrowDown') void move(i, i + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startY = e.clientY;
    drag = { from: i, over: i, dy: 0 };
  }

  function onMove(e: PointerEvent) {
    if (!drag) return;
    const dy = e.clientY - startY;
    let over = drag.from;
    const y = e.clientY;
    for (let j = 0; j < items.length; j++) {
      const el = items[j];
      if (!el || j === drag.from) continue;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (j < drag.from && y < mid) over = Math.min(over, j);
      if (j > drag.from && y > mid) over = Math.max(over, j);
    }
    drag = { ...drag, dy, over };
  }

  function onUp() {
    if (!drag) return;
    const { from, over } = drag;
    drag = null;
    if (over !== from) void move(from, over, false);
  }
</script>

<div class="builder">
  <p class="intro">Each phase plays until its rule fires, then hands over to the next. Drag the handle (or use the arrow keys on it) to reorder.</p>
  <ol class="phases">
    {#each phases as phase, i (i)}
      <li
        bind:this={items[i]}
        class:dragging={drag?.from === i}
        class:over-before={drag && drag.over === i && drag.over < drag.from}
        class:over-after={drag && drag.over === i && drag.over > drag.from}
        style:transform={drag?.from === i ? `translateY(${drag.dy}px)` : undefined}
      >
        <div class="head">
          <button
            type="button"
            class="handle"
            bind:this={handles[i]}
            aria-label="Phase {i + 1}: drag to reorder, or press the up and down arrow keys"
            onpointerdown={(e) => onDown(e, i)}
            onpointermove={onMove}
            onpointerup={onUp}
            onpointercancel={() => (drag = null)}
            onkeydown={(e) => onHandleKey(e, i)}
          >
            <span aria-hidden="true">⠿</span>
          </button>
          <h4>Phase {i + 1}</h4>
          <span class="rulesum">{describeRule(phase.when)}</span>
          <div class="btns">
            <button type="button" onclick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move phase {i + 1} up">↑</button>
            <button type="button" onclick={() => move(i, i + 1)} disabled={i === phases.length - 1} aria-label="Move phase {i + 1} down">↓</button>
            <button type="button" onclick={() => remove(i)} disabled={phases.length <= 1} aria-label="Remove phase {i + 1}">✕</button>
          </div>
        </div>
        <SpecEditor
          spec={phase.spec}
          onchange={(s) => setSpec(i, s)}
          {schemas}
          {issues}
          path={specPath(i)}
          depth={1}
          idPrefix="phase{i}"
          {freq}
          {maxGuesses}
          kindLabel="Plays"
        />
        {#if i < phases.length - 1}
          <div class="switch">
            <SwitchRuleEditor id="phase{i}-rule" label="Then switch" rule={phase.when} path={rulePath(i)} {issues} {maxGuesses} onchange={(r) => setRule(i, r)} />
          </div>
        {:else}
          <p class="last">Plays until the game ends.</p>
        {/if}
      </li>
    {/each}
  </ol>
  <button type="button" class="add" onclick={add}>+ Add phase</button>
  <p class="visually-hidden" aria-live="polite">{live}</p>
</div>

<style>
  .builder {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .intro {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .phases {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .phases > li {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
  }
  li.dragging {
    z-index: 2;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
    opacity: 0.95;
  }
  li.over-before::before,
  li.over-after::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  li.over-before::before {
    top: -7px;
  }
  li.over-after::after {
    bottom: -7px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  h4 {
    margin: 0;
    font-size: 0.95rem;
  }
  .rulesum {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .btns {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .switch {
    padding-top: 8px;
    border-top: 1px dashed var(--line);
  }
  .last {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  button {
    min-height: 44px;
    min-width: 44px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .handle {
    cursor: grab;
    touch-action: none;
    font-size: 1.2rem;
  }
  .add {
    align-self: flex-start;
  }
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
