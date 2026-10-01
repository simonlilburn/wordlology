<script lang="ts">
  // One row of the settings dialog: name, kind (result or display), default,
  // a dot when changed from the default, optional help, and the control.
  import type { Snippet } from 'svelte';
  import type { SettingKind } from './settings';

  interface Props {
    /** Base id; the name is `${id}-label`, help `${id}-help`. */
    id: string;
    label: string;
    kind: SettingKind;
    defaultText: string;
    changed: boolean;
    help?: string;
    /** Stack the control under the label (wide controls). */
    wide?: boolean;
    children: Snippet;
  }

  let { id, label, kind, defaultText, changed, help, wide = false, children }: Props = $props();
</script>

<div class="row {kind}" class:wide class:changed>
  <div class="text">
    <div class="name-line">
      <span class="dot" class:on={changed} title={changed ? 'Changed from the default' : undefined} aria-hidden="true"></span>
      <span class="name" id="{id}-label">{label}{#if changed}<span class="visually-hidden"> (changed from the default)</span>{/if}</span>
    </div>
    <div class="meta" id="{id}-help">
      <span class="kind-badge {kind}" title={kind === 'result' ? 'Part of the configuration: a change recomputes' : 'Only changes how things look'}
        >{kind === 'result' ? 'Result' : 'Display'}</span
      >
      <span class="default">Default: {defaultText}</span>
      {#if help}<span class="help">{help}</span>{/if}
    </div>
  </div>
  <div class="control">
    {@render children()}
  </div>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px 16px;
    padding: 10px 12px 10px 12px;
    border-left: 3px solid transparent;
    border-top: 1px solid var(--line);
  }
  .row.result {
    border-left-color: var(--accent);
  }
  .row.display {
    border-left-color: var(--line);
  }
  .row.wide {
    grid-template-columns: minmax(0, 1fr);
  }
  .text {
    min-width: 0;
  }
  .name-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .name {
    font-weight: 650;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: transparent;
  }
  .dot.on {
    background: var(--accent);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    margin: 3px 0 0 14px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .help {
    flex-basis: 100%;
  }
  .kind-badge {
    padding: 0 6px;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid currentColor;
  }
  .kind-badge.result {
    color: var(--accent);
  }
  .kind-badge.display {
    color: var(--muted);
  }
  .control {
    display: flex;
    justify-content: flex-end;
    min-width: 0;
  }
  .row.wide .control {
    justify-content: stretch;
    margin-left: 14px;
  }
  @media (max-width: 600px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
    }
    .control {
      justify-content: flex-start;
      margin-left: 14px;
    }
  }
</style>
