<!--
  Records the global hotkey that toggles the box: click "Change", press the
  new combination. Validated like Rust (hotkey.ts) before saving; errors are
  shown inline and announced.
-->
<script lang="ts">
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import { DEFAULT_HOTKEY } from '$lib/settings/defaults';
  import { formatHotkey, hotkeyFromEvent, parseHotkey } from '$lib/settings/hotkey';
  import Button from '$lib/ui/Button.svelte';
  import Kbd from '$lib/ui/Kbd.svelte';

  interface Props {
    value: string;
    /** Saves a canonical hotkey ("" = off); rejects with a message when refused. */
    onsave: (hotkey: string) => Promise<void>;
  }

  let { value, onsave }: Props = $props();
  const id = $props.id();

  let recording = $state(false);
  let held = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let field: HTMLButtonElement | undefined = $state();

  function start(): void {
    error = null;
    held = '';
    recording = true;
    field?.focus();
  }

  function stop(): void {
    recording = false;
    held = '';
  }

  function modifiers(e: KeyboardEvent): string {
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean).join('+');
  }

  async function save(next: string): Promise<void> {
    saving = true;
    try {
      await onsave(next);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      stop();
      return;
    }
    const hk = hotkeyFromEvent(e);
    if (!hk) {
      // Only modifiers so far (or an unsupported key): show what is held.
      held = modifiers(e);
      if (!['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(e.key)) {
        error = `"${e.key}" can't be used in a shortcut. Try a letter, digit or F-key.`;
      }
      return;
    }
    const text = formatHotkey(hk);
    const parsed = parseHotkey(text);
    if (!parsed.ok) {
      held = text;
      error = parsed.error;
      return;
    }
    stop();
    void save(text);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (recording) held = modifiers(e);
  }
</script>

<div class="recorder">
  <div class="row">
    <button
      bind:this={field}
      type="button"
      class="field"
      class:recording
      class:invalid={error !== null}
      data-capture-keys={recording ? '' : undefined}
      aria-describedby="{id}-help {id}-error"
      aria-label={recording ? 'Press the new shortcut, or Escape to cancel' : `Global shortcut: ${value || 'off'}. Activate to change`}
      onclick={() => (recording ? undefined : start())}
      onkeydown={onKeyDown}
      onkeyup={onKeyUp}
      onblur={stop}
    >
      <Keyboard size={15} aria-hidden="true" />
      {#if recording}
        <span class="prompt">{held ? `${held}+…` : 'Press the new shortcut…'}</span>
      {:else if value}
        <Kbd keys={value} size="sm" />
      {:else}
        <span class="off">Off</span>
      {/if}
    </button>
    {#if recording}
      <Button size="sm" variant="ghost" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={stop}>Cancel</Button>
    {:else}
      <Button size="sm" loading={saving} onclick={start}>Change</Button>
      {#if value}
        <Button size="sm" variant="ghost" disabled={saving} onclick={() => save('')}>Turn off</Button>
      {/if}
      {#if value !== DEFAULT_HOTKEY}
        <Button size="sm" variant="ghost" disabled={saving} onclick={() => save(DEFAULT_HOTKEY)}>Reset</Button>
      {/if}
    {/if}
  </div>
  <p class="help" id="{id}-help">Shows or hides the box from anywhere. Use Ctrl, Alt or Win with a key.</p>
  <p class="error" id="{id}-error" role="alert" data-testid="hotkey-error">{error ?? ''}</p>
</div>

<style>
  .recorder {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-1);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
  }
  .field {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 200px;
    height: var(--control-md);
    padding: 0 var(--space-3);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-md);
    background: var(--control-fill);
    color: var(--text-3);
    font-size: var(--text-md);
    text-align: left;
    transition:
      border-color var(--fade-1) linear,
      box-shadow var(--fade-2) linear;
  }
  .field:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .field.recording {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
    color: var(--accent-text);
  }
  .field.invalid.recording {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px rgb(var(--danger-rgb) / 0.18);
  }
  .prompt {
    font-weight: var(--weight-medium);
  }
  .off {
    color: var(--text-3);
  }
  .help,
  .error {
    margin: 0;
    font-size: var(--text-xs);
    text-align: right;
  }
  .help {
    color: var(--text-3);
  }
  .error {
    min-height: 1em;
    color: var(--danger);
    font-weight: var(--weight-medium);
  }
  .error:empty {
    display: none;
  }
</style>
