<!--
  Settings: Appearance (theme, accent, box skin/size/opacity with a live
  BoxVisual preview, editor size), Motion, Behaviour (hotkey recorder, …),
  Advanced (compatibility, low memory, refresh icons, export sizes) and
  About. Every change goes through updateSettings; refusals become toasts.
-->
<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Sun from '@lucide/svelte/icons/sun';
  import Scale from '@lucide/svelte/icons/scale';
  import { onMount, tick } from 'svelte';
  import { bootInfo } from '$lib/boot';
  import type { BoxSkin, MotionPref, OpenStyle, Settings, SizeClass, ThemeMode } from '$lib/ipc/types';
  import { commands } from '$lib/ipc/commands';
  import { motion } from '$lib/motion/speed.svelte';
  import { ICO_SIZES, PIXEL_GRIDS, REQUIRED_ICO_SIZES } from '$lib/settings/defaults';
  import { settings, updateSettings } from '$lib/settings/store.svelte';
  import BoxVisual from '$lib/ui/BoxVisual.svelte';
  import { metricsFor } from '$lib/ui/box-geometry';
  import Button from '$lib/ui/Button.svelte';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import LogoMark from '../chrome/LogoMark.svelte';
  import { getShell, type SettingsSection } from '../chrome/shell.svelte';
  import { errorText } from '../state/session.svelte';
  import HotkeyRecorder from './settings/HotkeyRecorder.svelte';
  import SettingRow from './settings/SettingRow.svelte';

  const shell = getShell();
  const s = $derived(settings());
  const info = (() => {
    try {
      return bootInfo();
    } catch {
      return null;
    }
  })();

  const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'motion', label: 'Motion' },
    { id: 'behaviour', label: 'Behaviour' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'about', label: 'About' },
  ];

  const SKINS: ReadonlyArray<{ value: BoxSkin; label: string }> = [
    { value: 'glass', label: 'Glass' },
    { value: 'neon', label: 'Neon' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'aurora', label: 'Aurora' },
  ];
  const SIZES: ReadonlyArray<{ value: SizeClass; label: string }> = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
  ];
  const THEMES = [
    { value: 'system' as ThemeMode, label: 'System', icon: Monitor },
    { value: 'light' as ThemeMode, label: 'Light', icon: Sun },
    { value: 'dark' as ThemeMode, label: 'Dark', icon: Moon },
  ];
  const MOTIONS: ReadonlyArray<{ value: MotionPref; label: string }> = [
    { value: 'system', label: 'Follow Windows' },
    { value: 'reduced', label: 'Always reduce' },
    { value: 'full', label: 'Always animate' },
  ];
  const OPEN_STYLES: ReadonlyArray<{ value: OpenStyle; label: string }> = [
    { value: 'morph', label: 'Morph' },
    { value: 'crossfade', label: 'Crossfade' },
  ];
  const GRIDS = PIXEL_GRIDS.map((g) => ({ value: String(g), label: `${g} × ${g}` }));
  /** Swatch metrics for the skin picker (a small box). */
  const SWATCH = { window: 76, visual: 56, margin: 10, radius: 15 };

  let active = $state<SettingsSection>('appearance');
  let scroller: HTMLElement | undefined = $state();
  const sectionEls: Partial<Record<SettingsSection, HTMLElement>> = {};

  async function set(patch: Partial<Settings>): Promise<void> {
    try {
      await updateSettings(patch);
    } catch (e) {
      toast({ message: `Couldn't save the setting: ${errorText(e)}`, kind: 'error' });
    }
  }

  async function saveHotkey(hotkey: string): Promise<void> {
    // Rethrow so the recorder shows Rust's reason inline too.
    try {
      await updateSettings({ hotkey });
      toast({ message: hotkey ? `Shortcut set to ${hotkey}.` : 'Global shortcut turned off.', kind: 'success' });
    } catch (e) {
      toast({ message: `Couldn't use that shortcut: ${errorText(e)}`, kind: 'error' });
      throw new Error(errorText(e));
    }
  }

  function toggleSize(size: number, on: boolean): void {
    const next = on ? [...s.icoSizes, size] : s.icoSizes.filter((n) => n !== size);
    void set({ icoSizes: [...new Set(next)].sort((a, b) => a - b) });
  }

  function jump(id: SettingsSection): void {
    active = id;
    sectionEls[id]?.scrollIntoView({ behavior: motion.reduced ? 'auto' : 'smooth', block: 'start' });
  }

  // Scroll spy: the nav follows the section at the top of the page.
  onMount(() => {
    const root = scroller;
    if (!root) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 24;
      let current: SettingsSection = 'appearance';
      for (const { id } of SECTIONS) {
        const el = sectionEls[id];
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = 'about';
      active = current;
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  });

  // Opening on a section (e.g. "About" from the tray menu).
  $effect(() => {
    const target = shell.settingsSection;
    void shell.openEpoch;
    if (!target) {
      scroller?.scrollTo({ top: 0 });
      active = 'appearance';
      return;
    }
    void tick().then(() => {
      sectionEls[target]?.scrollIntoView({ block: 'start' });
      active = target;
    });
  });
</script>

<section class="settings" aria-labelledby="settings-title" data-testid="settings-view">
  <nav class="nav" aria-label="Settings sections" data-stagger>
    <h1 id="settings-title">Settings</h1>
    {#each SECTIONS as sec (sec.id)}
      <button
        type="button"
        class="nav-item"
        aria-current={active === sec.id ? 'true' : undefined}
        onclick={() => jump(sec.id)}
      >
        {sec.label}
      </button>
    {/each}
  </nav>

  <div class="scroll" bind:this={scroller}>
    <div class="pages">
      <!-- Appearance ---------------------------------------------------------------->
      <section class="group" bind:this={sectionEls.appearance} aria-labelledby="s-appearance" data-stagger>
        <h2 id="s-appearance">Appearance</h2>
        <div class="card">
          <SettingRow label="Theme" description="Follow Windows, or pick one.">
            <SegmentedControl label="Theme" size="sm" options={THEMES} value={s.theme} onchange={(v) => set({ theme: v })} />
          </SettingRow>
          <div class="toggle-row">
            <Toggle
              label="Use the Windows accent colour"
              description="Tints buttons and highlights. Off: Reskin's violet."
              checked={s.useAccent}
              onchange={(v) => set({ useAccent: v })}
            />
            {#if info?.accent}<span class="accent" style:background={info.accent} title="Windows accent {info.accent}"></span>{/if}
          </div>
        </div>

        <div class="card box-card">
          <div class="preview" aria-label="Preview of the box on the desktop" role="img">
            <div class="desk"></div>
            <div class="box-preview" data-testid="box-preview" data-skin={s.boxSkin}>
              <BoxVisual
                metrics={metricsFor(s.boxSize)}
                skin={s.boxSkin}
                opacity={s.idleOpacity}
                compat={s.compatibilityMode}
                reducedMotion={motion.reduced}
              />
            </div>
            <span class="caption">Your box, at rest</span>
          </div>
          <div class="box-controls">
            <fieldset class="skins">
              <legend>Box skin</legend>
              <div class="skin-grid">
                {#each SKINS as skin (skin.value)}
                  <label class="skin" class:selected={s.boxSkin === skin.value}>
                    <input
                      type="radio"
                      name="box-skin"
                      value={skin.value}
                      checked={s.boxSkin === skin.value}
                      onchange={() => set({ boxSkin: skin.value })}
                    />
                    <span class="swatch" aria-hidden="true">
                      <BoxVisual metrics={SWATCH} skin={skin.value} opacity={1} reducedMotion />
                    </span>
                    <span class="skin-name">{skin.label}</span>
                  </label>
                {/each}
              </div>
            </fieldset>
            <div class="inline">
              <span class="field-label" id="box-size-label">Box size</span>
              <SegmentedControl label="Box size" size="sm" options={SIZES} value={s.boxSize} onchange={(v) => set({ boxSize: v })} />
            </div>
            <Slider
              label="Opacity at rest"
              min={0.25}
              max={1}
              step={0.01}
              value={s.idleOpacity}
              format={(v) => `${Math.round(v * 100)} %`}
              onchange={(v) => set({ idleOpacity: v })}
            />
          </div>
        </div>

        <div class="card">
          <SettingRow label="Editor size" description="Takes effect the next time the editor opens.">
            <SegmentedControl label="Editor size" size="sm" options={SIZES} value={s.editorSize} onchange={(v) => set({ editorSize: v })} />
          </SettingRow>
        </div>
      </section>

      <!-- Motion --------------------------------------------------------------------->
      <section class="group" bind:this={sectionEls.motion} aria-labelledby="s-motion" data-stagger>
        <h2 id="s-motion">Motion</h2>
        <div class="card">
          <SettingRow label="Animation speed" description="Scales every animation in Reskin.">
            <div class="slider">
              <Slider
                label="Animation speed"
                hideLabel
                min={0.5}
                max={2}
                step={0.25}
                value={s.animationSpeed}
                format={(v) => `${v}×`}
                onchange={(v) => set({ animationSpeed: v })}
              />
              <output class="value">{s.animationSpeed}×</output>
            </div>
          </SettingRow>
          <SettingRow label="Reduce motion" description="Fades instead of moving. “Follow Windows” uses the Animation effects setting.">
            <Select label="Reduce motion" hideLabel size="sm" options={MOTIONS} value={s.motion} onchange={(v) => set({ motion: v })} />
          </SettingRow>
          <SettingRow label="Opening the editor" description="Morph grows the box into the editor; crossfade simply fades.">
            <SegmentedControl label="Opening the editor" size="sm" options={OPEN_STYLES} value={s.openStyle} onchange={(v) => set({ openStyle: v })} />
          </SettingRow>
          <div class="toggle-row">
            <Toggle
              label="Fly the new icon to the desktop"
              description="After Save & Apply the box carries the icon to its place on the desktop."
              checked={s.flourish}
              onchange={(v) => set({ flourish: v })}
            />
          </div>
        </div>
      </section>

      <!-- Behaviour ---------------------------------------------------------------------->
      <section class="group" bind:this={sectionEls.behaviour} aria-labelledby="s-behaviour" data-stagger>
        <h2 id="s-behaviour">Behaviour</h2>
        <div class="card">
          <SettingRow label="Global shortcut" description="Toggles the box.">
            <HotkeyRecorder value={s.hotkey} onsave={saveHotkey} />
          </SettingRow>
          <div class="toggle-row">
            <Toggle label="Start with Windows" description="The box is there when you sign in." checked={s.autostart} onchange={(v) => set({ autostart: v })} />
          </div>
          <div class="toggle-row">
            <Toggle
              label="“Reskin this icon” in Explorer"
              description="Adds the command to the right-click menu of shortcuts and folders."
              checked={s.contextMenu}
              onchange={(v) => set({ contextMenu: v })}
            />
          </div>
          <div class="toggle-row">
            <Toggle
              label="Hide the box during full-screen apps"
              description="Games, videos and presentations stay undisturbed."
              checked={s.autoHideFullscreen}
              onchange={(v) => set({ autoHideFullscreen: v })}
            />
          </div>
          <div class="toggle-row">
            <Toggle
              label="Also update Start menu and taskbar pins"
              description="Shortcuts that launch the same app get the new icon too."
              checked={s.updatePins}
              onchange={(v) => set({ updatePins: v })}
            />
          </div>
          <div class="toggle-row">
            <Toggle label="Sounds" description="Soft effects for drops, applies and errors." checked={s.sounds} onchange={(v) => set({ sounds: v })} />
          </div>
        </div>
      </section>

      <!-- Advanced ------------------------------------------------------------------------>
      <section class="group" bind:this={sectionEls.advanced} aria-labelledby="s-advanced" data-stagger>
        <h2 id="s-advanced">Advanced</h2>
        <div class="card">
          <div class="toggle-row">
            <Toggle
              label="Compatibility mode"
              description="Opaque windows for PCs where transparent windows misbehave."
              checked={s.compatibilityMode}
              onchange={(v) => set({ compatibilityMode: v })}
            />
          </div>
          <div class="toggle-row">
            <Toggle
              label="Low-memory mode"
              description="Closes the editor completely when you're done. Opening takes a moment longer."
              checked={s.lowMemory}
              onchange={(v) => set({ lowMemory: v })}
            />
          </div>
          <SettingRow label="Refresh desktop icons" description="If Windows still shows an old icon. Rebuilding the cache redraws every icon.">
            <Button size="sm" icon={RefreshCw} onclick={() => shell.refreshIcons('notify')}>Refresh</Button>
            <Button size="sm" variant="ghost" onclick={() => shell.refreshIcons('rebuild')}>Rebuild cache</Button>
          </SettingRow>
          <SettingRow label="Icon sizes" description="Sizes written into .ico files. 16, 32, 48 and 256 px are always included." stacked>
            <div class="sizes" role="group" aria-label="Icon sizes">
              {#each ICO_SIZES as size (size)}
                {@const required = REQUIRED_ICO_SIZES.includes(size)}
                <label class="size" class:on={s.icoSizes.includes(size)} class:locked={required}>
                  <input
                    type="checkbox"
                    checked={s.icoSizes.includes(size)}
                    disabled={required}
                    onchange={(e) => toggleSize(size, e.currentTarget.checked)}
                  />
                  {size}
                </label>
              {/each}
            </div>
          </SettingRow>
          <SettingRow label="Pixel-art grid" description="Grid used when you switch a design to pixel art.">
            <Select
              label="Pixel-art grid"
              hideLabel
              size="sm"
              options={GRIDS}
              value={String(s.pixelGrid)}
              onchange={(v) => set({ pixelGrid: Number(v) })}
            />
          </SettingRow>
        </div>
      </section>

      <!-- About ------------------------------------------------------------------------------>
      <section class="group" bind:this={sectionEls.about} aria-labelledby="s-about" data-stagger>
        <h2 id="s-about">About</h2>
        <div class="card about">
          <LogoMark size={56} />
          <div class="about-text">
            <strong>Reskin</strong>
            <span data-testid="about-version">Version {info?.version ?? '—'} · {info?.build ?? ''}</span>
            <span class="muted">A floating box that turns any desktop icon into an editable canvas.</span>
          </div>
          <div class="about-actions">
            <Button icon={ExternalLink} onclick={() => shell.openReleases()}>Releases</Button>
            <Button variant="ghost" icon={Scale} onclick={() => void commands.openExternal('license').catch(() => {})}>
              MIT license
            </Button>
          </div>
        </div>
        <p class="credits">Made with Tauri, Svelte and Lucide icons. Updates are published on the Releases page.</p>
      </section>
    </div>
  </div>
</section>

<style>
  .settings {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-6) var(--space-3) var(--space-6) var(--space-5);
    border-right: 1px solid var(--divider);
  }
  h1 {
    margin: 0 0 var(--space-3) var(--space-2);
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  .nav-item {
    position: relative;
    height: 32px;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-md);
    text-align: left;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .nav-item:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .nav-item[aria-current='true'] {
    background: var(--surface-selected);
    color: var(--text);
    font-weight: var(--weight-medium);
  }
  .nav-item[aria-current='true']::before {
    content: '';
    position: absolute;
    left: 0;
    top: 9px;
    bottom: 9px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .nav-item:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }

  .scroll {
    min-height: 0;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .pages {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    max-width: 760px;
    padding: var(--space-6) var(--space-8) var(--space-10);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    scroll-margin-top: var(--space-6);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(var(--bg-rgb) / 0.25);
  }
  :global([data-theme='light']) .card {
    background: rgb(255 255 255 / 0.6);
  }
  .card > :global(* + *) {
    border-top: 1px solid var(--divider);
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    min-height: 56px;
  }
  .toggle-row > :global(.toggle) {
    flex: 1;
  }
  .accent {
    width: 18px;
    height: 18px;
    flex: none;
    order: -1;
    border-radius: var(--radius-full);
    box-shadow:
      inset 0 0 0 1px rgb(255 255 255 / 0.25),
      0 0 0 1px var(--border);
  }

  .box-card {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .box-card > :global(* + *) {
    border-top: 0;
  }
  .preview {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 240px;
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
    overflow: hidden;
  }
  .desk {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(80% 60% at 20% 15%, rgb(124 92 255 / 0.55), transparent 70%),
      radial-gradient(120% 90% at 85% 100%, #3d7bff 0%, #1c3f9e 45%, #0b1636 100%);
  }
  :global([data-theme='light']) .desk {
    background:
      radial-gradient(80% 60% at 20% 15%, rgb(255 255 255 / 0.9), transparent 70%),
      radial-gradient(120% 90% at 85% 100%, #9ec2ff 0%, #c9dcfb 55%, #eef3fc 100%);
  }
  .box-preview {
    position: relative;
  }
  .caption {
    position: absolute;
    bottom: var(--space-2);
    left: 0;
    right: 0;
    color: rgb(255 255 255 / 0.8);
    font-size: var(--text-xs);
    text-align: center;
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
  :global([data-theme='light']) .caption {
    color: rgb(20 30 60 / 0.65);
    text-shadow: none;
  }
  .box-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    border-left: 1px solid var(--divider);
  }
  .skins {
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend,
  .field-label {
    padding: 0;
    margin-bottom: var(--space-2);
    font-size: var(--text-md);
  }
  .skin-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-2);
  }
  .skin {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--shell-well);
    color: var(--text-2);
    font-size: var(--text-sm);
    transition:
      border-color var(--fade-1) linear,
      background-color var(--fade-1) linear;
  }
  .skin:hover {
    border-color: var(--border-strong);
  }
  .skin.selected {
    border-color: var(--accent);
    background: var(--surface-selected);
    color: var(--text);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .skin:has(input:focus-visible) {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  /* The real input covers its label: clickable, focusable, invisible. */
  .skin input,
  .size input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    margin: 0;
    opacity: 0;
    appearance: none;
  }
  .size.locked input {
    cursor: not-allowed;
  }
  .swatch {
    display: grid;
    place-items: center;
    width: 76px;
    height: 76px;
    border-radius: var(--radius-sm);
    background: radial-gradient(110% 90% at 80% 100%, #3d7bff 0%, #1c3f9e 50%, #0b1636 100%);
    transform: scale(0.82);
  }
  :global([data-theme='light']) .swatch {
    background: radial-gradient(110% 90% at 80% 100%, #9ec2ff 0%, #c9dcfb 55%, #eef3fc 100%);
  }
  .inline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .inline .field-label {
    margin: 0;
  }

  .slider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 240px;
  }
  .slider > :global(:first-child) {
    flex: 1;
  }
  .value {
    min-width: 36px;
    color: var(--text-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .sizes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1-5);
  }
  .size {
    position: relative;
    display: inline-grid;
    place-items: center;
    min-width: 44px;
    height: 28px;
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-full);
    background: var(--control-fill);
    color: var(--text-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .size:hover:not(.locked) {
    border-color: var(--border-strong);
  }
  .size.on {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--text);
  }
  .size.locked {
    opacity: 0.7;
  }
  .size:has(input:focus-visible) {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }

  .about {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4);
  }
  .about > :global(* + *) {
    border-top: 0;
  }
  .about-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
    font-size: var(--text-md);
  }
  .about-text strong {
    font-family: var(--font-display);
    font-size: var(--text-lg);
  }
  .muted {
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .about-actions {
    display: flex;
    gap: var(--space-2);
  }
  .credits {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }
</style>
