<!--
  Searchable font family picker (ARIA combobox + listbox). The list comes
  from the system (commands.systemFonts(), fetched once per page) and every
  family is previewed in its own face.
-->
<script module lang="ts">
  import { commands } from '$lib/ipc/commands';

  let fontList: Promise<string[]> | null = null;

  /** System font families, sorted and de-duplicated (cached). */
  function systemFonts(): Promise<string[]> {
    fontList ??= commands
      .systemFonts()
      .then((list) => [...new Set(list.map((f) => f.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
      .catch((error: unknown) => {
        fontList = null;
        throw error;
      });
    return fontList;
  }
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { dismissable, floating, portal } from '$lib/ui/floating';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { filterFonts } from './fonts';

  interface Props {
    value: string;
    label?: string;
    onchange: (family: string) => void;
  }

  let { value, label = 'Font', onchange }: Props = $props();

  const id = $props.id();
  let input: HTMLInputElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();
  let open = $state(false);
  let query = $state<string | null>(null);
  let active = $state(0);
  let fonts = $state<string[] | null>(null);
  let failed = $state(false);

  const matches = $derived(fonts ? filterFonts(fonts, query ?? '', value) : []);

  async function load(): Promise<void> {
    if (fonts) return;
    try {
      fonts = await systemFonts();
      failed = false;
    } catch (error) {
      console.warn('system fonts unavailable', error);
      failed = true;
      fonts = [];
    }
  }

  function show(): void {
    if (open) return;
    open = true;
    query = null;
    void load().then(() => {
      const i = matches.findIndex((f) => f === value);
      active = Math.max(0, i);
      scrollActive();
    });
  }

  function hide(restore: boolean): void {
    open = false;
    query = null;
    if (restore) input?.focus();
  }

  function choose(family: string): void {
    hide(true);
    if (family !== value) onchange(family);
  }

  function scrollActive(): void {
    queueMicrotask(() => listEl?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-opt-${active}`)}`)?.scrollIntoView({ block: 'nearest' }));
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          show();
          return;
        }
        const n = matches.length;
        if (n === 0) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        scrollActive();
        break;
      }
      case 'PageDown':
      case 'PageUp':
        if (!open || matches.length === 0) return;
        e.preventDefault();
        active = Math.min(matches.length - 1, Math.max(0, active + (e.key === 'PageDown' ? 8 : -8)));
        scrollActive();
        break;
      case 'Enter': {
        if (!open) return;
        e.preventDefault();
        const pick = matches[active];
        if (pick) choose(pick);
        else hide(false);
        break;
      }
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        hide(false);
        break;
      case 'Tab':
        if (open) hide(false);
        break;
    }
  }

  function onInput(e: Event & { currentTarget: HTMLInputElement }): void {
    query = e.currentTarget.value;
    active = 0;
    if (!open) show();
  }
</script>

<div class="font-picker" data-testid="font-picker">
  <label class="sr-only" for="{id}-input">{label}</label>
  <div class="field">
    <input
      bind:this={input}
      id="{id}-input"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={open ? `${id}-list` : undefined}
      aria-activedescendant={open && matches[active] ? `${id}-opt-${active}` : undefined}
      value={query ?? value}
      style:font-family={query === null ? `"${value}", var(--font-ui)` : undefined}
      onfocus={(e) => e.currentTarget.select()}
      onclick={show}
      oninput={onInput}
      onkeydown={onKeyDown}
    />
    <button type="button" class="chevron" tabindex="-1" aria-label="Show fonts" onclick={() => (open ? hide(true) : (show(), input?.focus()))}>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  </div>
</div>

{#if open}
  <div
    bind:this={listEl}
    class="list"
    id="{id}-list"
    role="listbox"
    aria-label="Fonts"
    tabindex="-1"
    {@attach portal()}
    {@attach floating({ anchor: () => input?.parentElement, placement: 'bottom-start', offset: 4, matchWidth: true })}
    {@attach dismissable(() => hide(false), () => [input?.parentElement])}
  >
    {#if fonts === null}
      <div class="status"><Spinner size={14} label="" /> Loading fonts…</div>
    {:else if matches.length === 0}
      <div class="status">{failed ? 'Fonts are unavailable' : 'No matching fonts'}</div>
    {:else}
      {#each matches as family, i (family)}
        <div
          id="{id}-opt-{i}"
          class="option"
          class:active={i === active}
          role="option"
          aria-selected={family === value}
          tabindex="-1"
          style:font-family={`"${family}", var(--font-ui)`}
          onpointermove={() => (active = i)}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => choose(family)}
          onkeydown={(e) => e.key === 'Enter' && choose(family)}
        >
          {family}
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .font-picker {
    flex: none;
    width: 168px;
  }
  .field {
    position: relative;
  }
  input {
    width: 100%;
    height: var(--control-sm);
    padding: 0 26px 0 10px;
    overflow: hidden;
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text);
    font-size: var(--text-md);
    text-overflow: ellipsis;
    box-shadow: var(--inset-highlight);
    outline: none;
  }
  input:hover {
    background: var(--control-fill-hover);
  }
  input:focus-visible,
  input[aria-expanded='true'] {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
  .chevron {
    position: absolute;
    top: 0;
    right: 0;
    display: grid;
    place-items: center;
    width: 24px;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: default;
  }

  .list {
    z-index: var(--z-popover);
    max-height: min(320px, var(--available, 320px));
    min-width: 220px;
    overflow: auto;
    padding: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-popover);
    overscroll-behavior: contain;
    transition: opacity var(--fade-1) linear;
  }
  @starting-style {
    .list {
      opacity: 0;
    }
  }
  .option {
    padding: 6px var(--space-2);
    overflow: hidden;
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 15px;
    line-height: 1.25;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: default;
  }
  .option.active {
    background: var(--surface-hover);
  }
  .option[aria-selected='true'] {
    color: var(--accent-text);
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
