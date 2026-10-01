<script lang="ts">
  import { untrack } from 'svelte';
  // A number input that keeps what the user typed (so "1." or "-" survive while
  // typing) and reports a number when the text parses, else the raw text (which
  // validation then flags).
  let {
    id,
    label,
    value,
    onchange,
    integer = false,
    min,
    max,
    step,
    help = '',
    issues = [],
  }: {
    id: string;
    label: string;
    value: unknown;
    onchange: (v: number | string) => void;
    integer?: boolean;
    min?: number;
    max?: number;
    step?: number;
    help?: string;
    issues?: string[];
  } = $props();

  function show(v: unknown): string {
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '';
  }

  function parse(t: string): number | string {
    const s = t.trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return t;
    const n = Number(s);
    return Number.isFinite(n) ? n : t;
  }

  let text = $state(untrack(() => show(value)));
  // Follow outside changes (another editor, a reset) without clobbering typing.
  $effect(() => {
    const v = value;
    if (parse(text) !== v && show(v) !== text) text = show(v);
  });

  function nudge(dir: 1 | -1) {
    const cur = typeof value === 'number' && Number.isFinite(value) ? value : (min ?? 0);
    const s = step ?? 1;
    let next = Math.round((cur + dir * s) / s) * s;
    next = Number(next.toFixed(6));
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    text = String(next);
    onchange(next);
  }

  const range = $derived(min !== undefined && max !== undefined ? `${min} to ${max}` : '');
</script>

<div class="field">
  <label for={id}>{label}</label>
  <div class="row">
    <input
      {id}
      type="text"
      inputmode={integer ? 'numeric' : 'decimal'}
      value={text}
      oninput={(e) => {
        text = e.currentTarget.value;
        onchange(parse(text));
      }}
      onkeydown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          nudge(e.key === 'ArrowUp' ? 1 : -1);
        }
      }}
      aria-invalid={issues.length > 0}
      aria-describedby="{id}-help"
      autocomplete="off"
      spellcheck="false"
    />
    <button type="button" onclick={() => nudge(-1)} aria-label="Decrease {label}">−</button>
    <button type="button" onclick={() => nudge(1)} aria-label="Increase {label}">+</button>
  </div>
  <p class="help" id="{id}-help">
    {help}{range ? ` (${range}${integer ? ', whole numbers' : ''})` : ''}
  </p>
  {#each issues as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  label {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 4px;
  }
  input {
    width: 8em;
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 1rem var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  input[aria-invalid='true'] {
    border-color: #d64545;
  }
  button {
    width: 44px;
    min-height: 44px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 1.1rem;
  }
  .help {
    margin: 0;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .issue {
    margin: 0;
    font-size: 0.8rem;
    color: #c03030;
  }
  input:focus-visible,
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
