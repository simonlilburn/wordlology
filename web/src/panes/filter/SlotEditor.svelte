<script lang="ts">
  // Editor for one letter position: any, a letter, a set, vowel or consonant, and "not".
  import { lettersOnly, SLOT_MODES, type SlotDraft, type SlotMode } from './builder';

  let {
    slot = $bindable(),
    position,
    id,
    onchange,
  }: { slot: SlotDraft; position: number; id: string; onchange: () => void } = $props();

  function setMode(m: SlotMode) {
    slot.mode = m;
    if (m === 'any') slot.negate = false;
    if (m === 'letter') slot.letters = slot.letters.slice(0, 1);
    onchange();
  }

  function setLetters(v: string) {
    const ls = lettersOnly(v);
    slot.letters = slot.mode === 'letter' ? ls.slice(-1) : ls;
    onchange();
  }
</script>

<div class="editor" {id} role="group" aria-label="Position {position}">
  <div class="modes" role="radiogroup" aria-label="Position {position} accepts">
    {#each SLOT_MODES as m (m.value)}
      <button type="button" role="radio" aria-checked={slot.mode === m.value} class:on={slot.mode === m.value} onclick={() => setMode(m.value)}>
        {m.label}
      </button>
    {/each}
  </div>
  {#if slot.mode === 'letter' || slot.mode === 'set'}
    <label class="letters">
      <span>{slot.mode === 'letter' ? 'Letter' : 'Letters'}</span>
      <input
        value={slot.letters.toUpperCase()}
        oninput={(e) => setLetters(e.currentTarget.value)}
        maxlength={slot.mode === 'letter' ? 2 : 26}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        placeholder={slot.mode === 'letter' ? 'A' : 'AEIOU'}
      />
    </label>
  {/if}
  <label class="neg" class:disabled={slot.mode === 'any'}>
    <input
      type="checkbox"
      checked={slot.negate}
      disabled={slot.mode === 'any'}
      onchange={(e) => {
        slot.negate = e.currentTarget.checked;
        onchange();
      }}
    />
    <span>Not (anything except this)</span>
  </label>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
  }
  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .modes button {
    min-height: 44px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .modes button.on {
    background: var(--fg);
    color: var(--bg);
    border-color: var(--fg);
  }
  .letters {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
  }
  .letters input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 600 1rem var(--font-mono);
    letter-spacing: 0.1em;
  }
  .neg {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    font-size: 0.85rem;
  }
  .neg input {
    width: 20px;
    height: 20px;
  }
  .neg.disabled {
    opacity: 0.5;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
