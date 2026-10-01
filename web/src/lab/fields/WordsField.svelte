<script lang="ts">
  import { untrack } from 'svelte';
  // A word list typed as text ("crane, slate" or one per line), reported as lowercase words.
  import { parseWords } from '../lab';

  let {
    id,
    label,
    value,
    onchange,
    help = '',
    issues = [],
  }: { id: string; label: string; value: unknown; onchange: (words: string[]) => void; help?: string; issues?: string[] } = $props();

  function show(v: unknown): string {
    return Array.isArray(v) ? v.map((w) => String(w).toUpperCase()).join(', ') : '';
  }

  let text = $state(untrack(() => show(value)));
  $effect(() => {
    const v = value;
    const words = Array.isArray(v) ? v.map((w) => String(w).toLowerCase()) : [];
    if (parseWords(text).join(',') !== words.join(',')) text = show(v);
  });
</script>

<div class="field">
  <label for={id}>{label}</label>
  <input
    {id}
    value={text}
    oninput={(e) => {
      text = e.currentTarget.value;
      onchange(parseWords(text));
    }}
    onblur={() => (text = show(value))}
    aria-invalid={issues.length > 0}
    aria-describedby="{id}-help"
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    placeholder="CRANE, TOILS"
  />
  <p class="help" id="{id}-help">{help} Separate words with commas or spaces.</p>
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
  input {
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 600 0.95rem var(--font-mono);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  input[aria-invalid='true'] {
    border-color: #d64545;
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
  input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
