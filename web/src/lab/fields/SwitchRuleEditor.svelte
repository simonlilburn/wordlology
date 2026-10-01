<script lang="ts">
  // A switch rule: after k guesses, at ≤ n candidates, at ≤ h bits, or when the sequence ends.
  import type { SwitchRule } from '../../backend/types';
  import NumberField from './NumberField.svelte';

  let {
    id,
    label = 'Switch when',
    rule,
    onchange,
    issues = [],
    path,
    maxGuesses = 6,
  }: {
    id: string;
    label?: string;
    rule: unknown;
    onchange: (r: SwitchRule) => void;
    issues?: { path: string; message: string }[];
    path: string;
    maxGuesses?: number;
  } = $props();

  const RULES: { when: SwitchRule['when']; label: string }[] = [
    { when: 'after_turns', label: 'After a number of guesses' },
    { when: 'candidates_le', label: 'When few candidates remain' },
    { when: 'bits_le', label: 'When little information remains' },
    { when: 'sequence_exhausted', label: 'When the word sequence runs out' },
  ];

  const r = $derived((rule && typeof rule === 'object' ? rule : { when: 'after_turns', k: 2 }) as Record<string, unknown>);
  const at = (p: string) => issues.filter((i) => i.path === p).map((i) => i.message);

  function setWhen(w: SwitchRule['when']) {
    switch (w) {
      case 'after_turns':
        onchange({ when: w, k: typeof r.k === 'number' ? r.k : 2 });
        break;
      case 'candidates_le':
        onchange({ when: w, n: typeof r.n === 'number' ? r.n : 10 });
        break;
      case 'bits_le':
        onchange({ when: w, h: typeof r.h === 'number' ? r.h : 3 });
        break;
      case 'sequence_exhausted':
        onchange({ when: w });
    }
  }

  function setValue(name: 'k' | 'n' | 'h', v: number | string) {
    onchange({ ...(r as object), [name]: v } as SwitchRule);
  }
</script>

<div class="rule">
  <label for="{id}-when">{label}</label>
  <select id="{id}-when" value={r.when} onchange={(e) => setWhen(e.currentTarget.value as SwitchRule['when'])}>
    {#each RULES as o (o.when)}<option value={o.when}>{o.label}</option>{/each}
  </select>
  {#each at(path) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
  {#if r.when === 'after_turns'}
    <NumberField id="{id}-k" label="Guesses k" integer min={1} max={Math.max(1, maxGuesses - 1)} value={r.k} onchange={(v) => setValue('k', v)} help="Switch after this many guesses." issues={at(`${path}.k`)} />
  {:else if r.when === 'candidates_le'}
    <NumberField id="{id}-n" label="Candidates n" integer min={1} max={100000} value={r.n} onchange={(v) => setValue('n', v)} help="Switch once at most this many answers are possible." issues={at(`${path}.n`)} />
  {:else if r.when === 'bits_le'}
    <NumberField id="{id}-h" label="Bits h" min={0} max={32} step={0.5} value={r.h} onchange={(v) => setValue('h', v)} help="Switch once log2(candidates) is at most this." issues={at(`${path}.h`)} />
  {/if}
</div>

<style>
  .rule {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  label {
    font-size: 0.85rem;
    font-weight: 600;
  }
  select {
    min-height: 44px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    padding: 0 8px;
    font: inherit;
  }
  select:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
  .issue {
    margin: 0;
    font-size: 0.8rem;
    color: #c03030;
  }
</style>
