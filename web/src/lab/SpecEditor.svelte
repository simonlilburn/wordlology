<script lang="ts">
  // A form generated from a strategy's parameter schema (recursive for
  // combinators). Edits are immutable: every change hands a new spec to
  // `onchange`. Validation issues arrive from the Lab with dotted paths.
  import type { ParamField, StrategySchema, StrategySpec } from '../backend/types';
  import SpecEditor from './SpecEditor.svelte';
  import NumberField from './fields/NumberField.svelte';
  import SwitchRuleEditor from './fields/SwitchRuleEditor.svelte';
  import WordsField from './fields/WordsField.svelte';
  import { changeKind, defaultSpec, schemaFor, type Issue } from './lab';

  type AnySpec = Record<string, unknown> & { kind: string };

  let {
    spec,
    onchange,
    schemas,
    issues = [],
    path = '',
    depth = 0,
    idPrefix,
    freq = true,
    maxGuesses = 6,
    kindLabel = 'Strategy',
  }: {
    spec: StrategySpec;
    onchange: (next: StrategySpec) => void;
    schemas: StrategySchema[];
    issues?: Issue[];
    path?: string;
    depth?: number;
    idPrefix: string;
    freq?: boolean;
    maxGuesses?: number;
    kindLabel?: string;
  } = $props();

  const s = $derived(spec as unknown as AnySpec);
  const schema = $derived(schemaFor(s.kind, schemas));
  const join = (a: string, b: string | number) => (a ? `${a}.${b}` : String(b));
  const idOf = (p: string) => `${idPrefix}-${(p || 'root').replace(/[^a-z0-9_-]/gi, '-')}`;
  const at = (p: string) => issues.filter((i) => i.path === p).map((i) => i.message);
  const weightsField = $derived(schema?.params.find((p) => p.type.type === 'weights'));
  const strategiesField = $derived(schema?.params.find((p) => p.type.type === 'strategies'));

  function set(name: string, v: unknown) {
    onchange({ ...s, [name]: v } as unknown as StrategySpec);
  }

  function setKind(kind: string) {
    onchange(changeKind(spec, kind, schemas));
  }

  function listOf(name: string): StrategySpec[] {
    const v = s[name];
    return Array.isArray(v) ? (v as StrategySpec[]) : [];
  }

  function weightsOf(): number[] {
    const v = weightsField ? s[weightsField.name] : undefined;
    return Array.isArray(v) ? (v as number[]) : [];
  }

  function setMember(f: ParamField, i: number, next: StrategySpec) {
    const list = listOf(f.name).slice();
    list[i] = next;
    set(f.name, list);
  }

  function addMember(f: ParamField) {
    const list = [...listOf(f.name), defaultSpec('random', schemas)];
    const next: AnySpec = { ...s, [f.name]: list };
    if (weightsField) next[weightsField.name] = [...weightsOf(), 1];
    onchange(next as unknown as StrategySpec);
  }

  function removeMember(f: ParamField, i: number) {
    const list = listOf(f.name).filter((_, j) => j !== i);
    const next: AnySpec = { ...s, [f.name]: list };
    if (weightsField) next[weightsField.name] = weightsOf().filter((_, j) => j !== i);
    onchange(next as unknown as StrategySpec);
  }

  function setWeight(i: number, v: number | string) {
    if (!weightsField) return;
    const w: unknown[] = weightsOf().slice();
    while (w.length < listOf(strategiesField?.name ?? '').length) w.push(1);
    w[i] = v;
    set(weightsField.name, w);
  }
</script>

<div class="spec" class:nested={depth > 0}>
  <div class="kind">
    <label for={idOf(join(path, 'kind'))}>{kindLabel}</label>
    <select id={idOf(join(path, 'kind'))} value={s.kind} onchange={(e) => setKind(e.currentTarget.value)} aria-describedby={schema ? `${idOf(path)}-desc` : undefined}>
      {#if !schema}<option value={s.kind}>{s.kind} (unknown)</option>{/if}
      {#each schemas as o (o.kind)}
        <option value={o.kind} disabled={o.needs?.frequencies && !freq}>
          {o.label}{o.needs?.frequencies && !freq ? ' (needs word frequencies)' : ''}
        </option>
      {/each}
    </select>
  </div>
  {#if schema}
    <p class="desc" id="{idOf(path)}-desc">
      {schema.description}
      <span class="badge">{schema.determinism}</span>
    </p>
  {/if}
  {#each at(path) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}

  {#each schema?.params ?? [] as f (f.name)}
    {@const p = join(path, f.name)}
    {@const id = idOf(p)}
    {@const t = f.type}
    {#if t.type === 'number'}
      <NumberField {id} label={f.label} help={f.help} value={s[f.name]} min={t.min} max={t.max} step={t.step} issues={at(p)} onchange={(v) => set(f.name, v)} />
    {:else if t.type === 'integer'}
      <NumberField {id} label={f.label} help={f.help} value={s[f.name]} integer min={t.min} max={t.max} step={1} issues={at(p)} onchange={(v) => set(f.name, v)} />
    {:else if t.type === 'boolean'}
      <div class="field">
        <label class="check">
          <input type="checkbox" checked={s[f.name] === true} onchange={(e) => set(f.name, e.currentTarget.checked)} aria-describedby="{id}-help" />
          <span>{f.label}</span>
        </label>
        <p class="help" id="{id}-help">{f.help}</p>
        {#each at(p) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
      </div>
    {:else if t.type === 'choice'}
      <div class="field">
        <label for={id}>{f.label}</label>
        <select {id} value={s[f.name]} onchange={(e) => set(f.name, e.currentTarget.value)} aria-describedby="{id}-help" aria-invalid={at(p).length > 0}>
          {#each t.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
        <p class="help" id="{id}-help">{f.help}</p>
        {#each at(p) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
      </div>
    {:else if t.type === 'words'}
      <WordsField {id} label={f.label} help={f.help} value={s[f.name]} issues={at(p)} onchange={(v) => set(f.name, v)} />
    {:else if t.type === 'switch_rule'}
      <SwitchRuleEditor {id} label={f.label} rule={s[f.name]} path={p} {issues} {maxGuesses} onchange={(v) => set(f.name, v)} />
    {:else if t.type === 'strategy'}
      <fieldset class="sub">
        <legend>{f.label}</legend>
        {#if s[f.name] && typeof s[f.name] === 'object'}
          <SpecEditor
            spec={s[f.name] as StrategySpec}
            onchange={(v) => set(f.name, v)}
            {schemas}
            {issues}
            path={p}
            depth={depth + 1}
            {idPrefix}
            {freq}
            {maxGuesses}
          />
        {:else}
          <button type="button" onclick={() => set(f.name, defaultSpec('max_info', schemas))}>Choose a strategy</button>
        {/if}
        {#each at(p) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
      </fieldset>
    {:else if t.type === 'strategies'}
      <fieldset class="sub">
        <legend>{f.label}</legend>
        <p class="help">{f.help}</p>
        {#each at(p) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
        {#if weightsField}{#each at(join(path, weightsField.name)) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}{/if}
        <ol class="members">
          {#each listOf(f.name) as member, i (i)}
            <li>
              <div class="memberhead">
                <span class="num">{i + 1}</span>
                {#if weightsField}
                  <NumberField
                    id="{id}-w{i}"
                    label="Weight"
                    min={0}
                    max={1000}
                    step={0.1}
                    value={weightsOf()[i]}
                    onchange={(v) => setWeight(i, v)}
                    issues={at(join(join(path, weightsField.name), i))}
                  />
                {/if}
                <button type="button" class="remove" onclick={() => removeMember(f, i)} disabled={listOf(f.name).length <= 1} aria-label="Remove strategy {i + 1}">Remove</button>
              </div>
              <SpecEditor
                spec={member}
                onchange={(v) => setMember(f, i, v)}
                {schemas}
                {issues}
                path={join(p, i)}
                depth={depth + 1}
                {idPrefix}
                {freq}
                {maxGuesses}
              />
            </li>
          {/each}
        </ol>
        <button type="button" onclick={() => addMember(f)}>+ Add strategy</button>
      </fieldset>
    {:else if t.type === 'weights'}
      {#if !strategiesField}
        <div class="field">
          <label for={id}>{f.label}</label>
          <input
            {id}
            value={Array.isArray(s[f.name]) ? (s[f.name] as number[]).join(', ') : ''}
            oninput={(e) =>
              set(
                f.name,
                e.currentTarget.value
                  .split(/[\s,;]+/)
                  .filter(Boolean)
                  .map((x) => (Number.isFinite(Number(x)) ? Number(x) : x)),
              )}
            aria-describedby="{id}-help"
          />
          <p class="help" id="{id}-help">{f.help}</p>
          {#each at(p) as m, mi (mi)}<p class="issue" role="alert">{m}</p>{/each}
        </div>
      {/if}
    {/if}
  {/each}
</div>

<style>
  .spec {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .kind {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  label {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  select,
  input:not([type='checkbox']) {
    min-height: 44px;
    box-sizing: border-box;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    padding: 0 8px;
    font: inherit;
    max-width: 100%;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    font-weight: 600;
  }
  .check input {
    width: 20px;
    height: 20px;
  }
  .desc {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .badge {
    display: inline-block;
    margin-left: 4px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.72rem;
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
  fieldset.sub {
    margin: 0;
    padding: 10px;
    border: 1px solid var(--line);
    border-left: 3px solid color-mix(in srgb, var(--accent) 50%, var(--line));
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  legend {
    padding: 0 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
  }
  .members {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .members > li {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px dashed var(--line);
    border-radius: 8px;
  }
  .memberhead {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .num {
    align-self: center;
    font-weight: 700;
    color: var(--muted);
  }
  button {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    align-self: flex-start;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .remove {
    margin-left: auto;
  }
  select:focus-visible,
  input:focus-visible,
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
