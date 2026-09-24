<!-- On/off switch (role="switch") with a clickable label and optional description. -->
<script lang="ts">
  interface Props {
    checked?: boolean;
    label: string;
    description?: string;
    /** Keep the label for assistive tech only. */
    hideLabel?: boolean;
    disabled?: boolean;
    size?: 'sm' | 'md';
    onchange?: (checked: boolean) => void;
  }

  let {
    checked = $bindable(false),
    label,
    description,
    hideLabel = false,
    disabled = false,
    size = 'md',
    onchange,
  }: Props = $props();

  const id = $props.id();

  function toggle(): void {
    checked = !checked;
    onchange?.(checked);
  }
</script>

<div class="toggle size-{size}" class:disabled>
  <span class="text" class:sr-only={hideLabel}>
    <label class="label" id="{id}-label" for="{id}-switch">{label}</label>
    {#if description}<span class="desc" id="{id}-desc">{description}</span>{/if}
  </span>
  <button
    id="{id}-switch"
    type="button"
    role="switch"
    class="switch"
    aria-checked={checked}
    aria-labelledby="{id}-label"
    aria-describedby={description ? `${id}-desc` : undefined}
    {disabled}
    onclick={toggle}
  >
    <span class="thumb"></span>
  </button>
</div>

<style>
  .toggle {
    --w: 40px;
    --h: 20px;
    --t: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: var(--control-md);
  }
  .size-sm {
    --w: 32px;
    --h: 16px;
    --t: 10px;
  }
  .disabled {
    opacity: 0.5;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .label {
    color: var(--text);
    font-size: var(--text-md);
  }
  .desc {
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }

  .switch {
    position: relative;
    flex: none;
    width: var(--w);
    height: var(--h);
    padding: 0;
    border: 1px solid var(--control-border-bottom);
    border-radius: var(--radius-full);
    background: var(--control-fill);
    cursor: default;
    transition:
      background-color var(--fade-2) linear,
      border-color var(--fade-2) linear;
  }
  .switch:hover:not(:disabled) {
    background: var(--control-fill-hover);
  }
  .switch:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: var(--focus-offset);
  }
  .thumb {
    position: absolute;
    top: 50%;
    left: calc((var(--h) - var(--t)) / 2 - 1px);
    width: var(--t);
    height: var(--t);
    margin-top: calc(var(--t) / -2);
    border-radius: 50%;
    background: var(--text-2);
    transition:
      transform var(--dur-spring) var(--ease-spring),
      background-color var(--fade-2) linear,
      width var(--dur-2) var(--ease-standard);
  }
  .switch:active:not(:disabled) .thumb {
    width: calc(var(--t) + 3px);
  }
  .switch[aria-checked='true'] {
    border-color: transparent;
    background: var(--accent);
  }
  .switch[aria-checked='true']:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .switch[aria-checked='true'] .thumb {
    background: var(--on-accent);
    transform: translateX(calc(var(--w) - var(--h)));
  }
  .switch[aria-checked='true']:active:not(:disabled) .thumb {
    transform: translateX(calc(var(--w) - var(--h) - 3px));
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
