<!--
  BoxVisual — the floating box's picture. Rendered by the box page AND by the
  editor as the morph proxy, so it is a pure function of its props (plus the
  global theme / accent / motion-speed custom properties): the same props
  give the same pixels in both windows.

  Layout: the root is exactly metrics.window × metrics.window CSS px; the
  visual box (metrics.visual, radius metrics.radius) is centred in it. See
  box-geometry.ts for the matching rects and resting transforms.

  Motion rules: idle is completely static (no running animations). Looping
  keyframes exist only while armed (particles, aurora drift) or busy without
  a known progress. Reduced motion removes all movement; state changes then
  read through colour/opacity only.

  Compatibility mode: the window is opaque and Rust clips it to the visual
  box (a rounded window region), so nothing that matters may live in the
  margin: the box itself does not scale or move (the content inside it
  squashes and shakes instead), and the badge and busy ring sit inside.
  The hint and the error message are drawn inside the box for the same
  reason.
-->
<script lang="ts">
  import type { BoxMetrics, BoxSkin } from '$lib/ipc/types';
  import {
    ABSORB_MS,
    CELEBRATE_MS,
    ERROR_MS,
    ICON_FRACTION,
    ringRadius,
    ringRect,
    roundedRectPath,
    STATE_TRANSFORM,
    transformCss,
    type BoxVisualState,
  } from './box-geometry';

  interface Props {
    metrics: BoxMetrics;
    skin?: BoxSkin;
    state?: BoxVisualState;
    /** Icon to show centred (data URL), or null for the empty-box mark. */
    icon?: string | null;
    /** Number of dragged/loaded items; a badge shows when > 1. */
    count?: number;
    /** Progress 0..1 for the busy ring; null = indeterminate. */
    progress?: number | null;
    /** Opacity of the box while idle (settings.idleOpacity). */
    opacity?: number;
    /** Compatibility mode: fully opaque rendering. */
    compat?: boolean;
    reducedMotion?: boolean;
    /** Short hint under the mark, e.g. "Drag a shortcut onto me". */
    hint?: string | null;
    /**
     * Why the box shook (error state): shown under the mark in place of the
     * hint, up to three lines.
     */
    message?: string | null;
  }

  let {
    metrics,
    skin = 'glass',
    state = 'idle',
    icon = null,
    count = 0,
    progress = null,
    opacity = 1,
    compat = false,
    reducedMotion = false,
    hint = null,
    message = null,
  }: Props = $props();

  // Inward-drifting particles while armed: angle, stagger and size.
  const PARTICLES = Array.from({ length: 14 }, (_, i) => ({
    angle: i * (360 / 14) + (i % 3) * 7,
    delay: (i * 173) % 1400,
    size: 2.5 + ((i * 7) % 4) * 0.5,
  }));
  const SPARKS = Array.from({ length: 10 }, (_, i) => ({
    angle: i * 36 + (i % 2) * 12,
    size: i % 2 ? 7 : 11,
    delay: (i % 3) * 40,
  }));

  const ringPath = $derived(roundedRectPath(ringRect(metrics, undefined, compat), ringRadius(metrics, compat)));
  const bodyTransform = $derived(compat ? 'none' : transformCss(STATE_TRANSFORM[state]));
  const pct = $derived(progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10);
  const bodyOpacity = $derived(state === 'idle' ? Math.min(1, Math.max(0, opacity)) : 1);
  const caption = $derived(icon !== null ? null : (message ?? hint));
</script>

<div
  class="bv skin-{skin} state-{state}"
  class:compat
  class:reduced={reducedMotion}
  class:with-icon={icon !== null}
  class:with-hint={caption !== null}
  data-skin={skin}
  data-state={state}
  aria-hidden="true"
  style:--bv-win="{metrics.window}px"
  style:--bv-vis="{metrics.visual}px"
  style:--bv-m="{metrics.margin}px"
  style:--bv-r="{metrics.radius}px"
  style:--bv-icon={ICON_FRACTION}
  style:--bv-absorb="{ABSORB_MS}ms"
  style:--bv-celebrate="{CELEBRATE_MS}ms"
  style:--bv-error="{ERROR_MS}ms"
>
  <div class="body" style:transform={bodyTransform} style:opacity={bodyOpacity}>
    <div class="shadow"></div>
    <div class="shadow lift"></div>
    <div class="glow"></div>
    <div class="box">
      <div class="clip">
        <div class="fill"></div>
        <div class="grain"></div>
        <div class="sheen"></div>
        <div class="content">
          {#if icon !== null}
            <img class="icon" src={icon} alt="" draggable="false" />
          {:else}
            <span class="glyphs">
              <svg class="glyph mark" viewBox="0 0 48 48">
                <path
                  d="M22 9c1.3 9.4 3.6 11.7 13 13-9.4 1.3-11.7 3.6-13 13-1.3-9.4-3.6-11.7-13-13 9.4-1.3 11.7-3.6 13-13Z"
                />
                <path
                  d="M36 6c.6 4.4 1.6 5.4 6 6-4.4.6-5.4 1.6-6 6-.6-4.4-1.6-5.4-6-6 4.4-.6 5.4-1.6 6-6Z"
                  opacity=".75"
                />
              </svg>
              <svg class="glyph drop" viewBox="0 0 48 48">
                <path d="M24 8v19M15.5 19.5 24 28l8.5-8.5M10 32v3a5 5 0 0 0 5 5h18a5 5 0 0 0 5-5v-3" />
              </svg>
            </span>
            {#if caption !== null}
              <span class="hint" class:message={message !== null}>{caption}</span>
            {/if}
          {/if}
        </div>
        <div class="flash"></div>
      </div>
      <div class="rim"></div>
      <div class="rim hot"></div>
    </div>

    {#if state === 'armed' && !reducedMotion}
      <div class="particles">
        {#each PARTICLES as p, i (i)}
          <i style:--a="{p.angle}deg" style:--d="{p.delay}ms" style:--s="{p.size}px"></i>
        {/each}
      </div>
    {/if}

    {#if count > 1}
      <div class="badge">{count > 99 ? '99+' : count}</div>
    {/if}

    {#if state === 'celebrate'}
      <div class="burst">
        <div class="ripple"></div>
        {#if !reducedMotion}
          <div class="ripple second"></div>
          {#each SPARKS as s, i (i)}
            <svg
              class="spark"
              viewBox="0 0 24 24"
              style:--a="{s.angle}deg"
              style:--z="{s.size}px"
              style:--d="{s.delay}ms"
            >
              <path d="M12 0c.9 6.6 2.4 8.1 12 12-9.6 3.9-11.1 5.4-12 12-.9-6.6-2.4-8.1-12-12 9.6-3.9 11.1-5.4 12-12Z" />
            </svg>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  {#if state === 'busy'}
    <svg class="ring" class:indeterminate={pct === null} viewBox="0 0 {metrics.window} {metrics.window}">
      <path class="track" d={ringPath} />
      <path
        class="bar"
        d={ringPath}
        pathLength="100"
        style:stroke-dasharray={pct === null ? '22 78' : `${pct} ${100 - pct + 0.001}`}
      />
    </svg>
  {/if}
</div>

<style>
  /* ------------------------------------------------------------------ */
  /* Frame                                                                */
  /* ------------------------------------------------------------------ */
  .bv {
    /* Skin knobs (Glass defaults, dark). */
    --bv-glow-rgb: var(--accent-vivid-rgb);
    --bv-ink: rgb(255 255 255 / 0.9);
    --bv-ink-soft: rgb(255 255 255 / 0.62);
    --bv-rim: linear-gradient(
      155deg,
      rgb(255 255 255 / 0.85) 0%,
      rgb(255 255 255 / 0.22) 30%,
      rgb(255 255 255 / 0.06) 55%,
      rgb(255 255 255 / 0.14) 78%,
      rgb(255 255 255 / 0.42) 100%
    );
    --bv-rim-hot: linear-gradient(
      155deg,
      rgb(255 255 255 / 0.95) 0%,
      rgb(var(--bv-glow-rgb) / 0.95) 35%,
      rgb(var(--bv-glow-rgb) / 0.55) 65%,
      rgb(255 255 255 / 0.8) 100%
    );
    --bv-shadow: 0 7px 12px -5px rgb(0 0 0 / 0.42), 0 2px 5px -1px rgb(0 0 0 / 0.26);
    --bv-shadow-lift: 0 10px 14px -6px rgb(0 0 0 / 0.46), 0 3px 7px -2px rgb(0 0 0 / 0.28);
    --bv-inset: inset 0 1px 0.5px rgb(255 255 255 / 0.55), inset 0 -14px 22px -14px rgb(0 0 0 / 0.38),
      inset 0 0 0 1px rgb(255 255 255 / 0.06);

    position: relative;
    width: var(--bv-win);
    height: var(--bv-win);
    flex: none;
    user-select: none;
    pointer-events: none;
    -webkit-user-drag: none;
    font-family: var(--font-ui);
  }

  .body {
    position: absolute;
    inset: var(--bv-m);
    transform-origin: 50% 50%;
    transition:
      transform var(--dur-spring) var(--ease-spring),
      opacity var(--fade-2) linear;
  }

  .shadow,
  .glow,
  .box {
    position: absolute;
    inset: 0;
    border-radius: var(--bv-r);
  }

  .shadow {
    box-shadow: var(--bv-shadow);
    transition: opacity var(--fade-2) linear;
  }
  .shadow.lift {
    box-shadow: var(--bv-shadow-lift);
    opacity: 0;
  }

  .glow {
    box-shadow:
      0 0 0 1px rgb(var(--bv-glow-rgb) / 0.55),
      0 0 9px 1px rgb(var(--bv-glow-rgb) / 0.6);
    opacity: 0;
    transition: opacity var(--fade-2) linear;
  }

  .box {
    box-shadow: var(--bv-inset);
  }

  .clip {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    overflow: hidden;
    /* Keeps the rounded clip on the GPU while the body scales. */
    isolation: isolate;
  }

  .fill,
  .grain,
  .sheen,
  .flash {
    position: absolute;
    inset: 0;
  }

  .grain {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 160px 160px;
    mix-blend-mode: overlay;
    opacity: 0.1;
  }

  .flash {
    background: radial-gradient(closest-side, rgb(var(--bv-glow-rgb) / 0.55), transparent);
    opacity: 0;
  }

  /* Gradient hairline border that follows the radius (mask trick). */
  .rim {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: var(--bv-rim);
    mask:
      linear-gradient(#000 0 0) content-box exclude,
      linear-gradient(#000 0 0);
    transition: opacity var(--fade-2) linear;
  }
  .rim.hot {
    padding: 1.5px;
    background: var(--bv-rim-hot);
    opacity: 0;
  }

  /* ------------------------------------------------------------------ */
  /* Content                                                              */
  /* ------------------------------------------------------------------ */
  .content {
    position: absolute;
    inset: 0;
  }

  /* Exactly iconRect() from box-geometry (ICON_FRACTION of the box, centred). */
  .icon {
    position: absolute;
    left: calc((1 - var(--bv-icon)) * 50%);
    top: calc((1 - var(--bv-icon)) * 50%);
    width: calc(var(--bv-icon) * 100%);
    height: calc(var(--bv-icon) * 100%);
    object-fit: contain;
    filter: drop-shadow(0 3px 5px rgb(0 0 0 / 0.34)) drop-shadow(0 1px 1px rgb(0 0 0 / 0.2));
    -webkit-user-drag: none;
  }

  .glyphs {
    position: absolute;
    left: 31%;
    top: 31%;
    width: 38%;
    height: 38%;
    transition: transform var(--dur-spring) var(--ease-spring);
  }

  .glyph {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    transition:
      opacity var(--fade-2) linear,
      transform var(--dur-spring) var(--ease-spring);
  }
  .glyph.mark {
    fill: var(--bv-ink-soft);
    filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.25));
  }
  .glyph.drop {
    fill: none;
    stroke: var(--bv-ink);
    stroke-width: 3.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
    transform: translateY(-6px) scale(0.9);
    filter: drop-shadow(0 0 5px rgb(var(--bv-glow-rgb) / 0.8));
  }

  .with-hint .glyphs {
    left: 36%;
    top: 17%;
    width: 28%;
    height: 28%;
  }
  .hint {
    position: absolute;
    left: 8%;
    right: 8%;
    top: 52%;
    font-size: calc(var(--bv-vis) * 0.084);
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
    letter-spacing: 0.005em;
    color: var(--bv-ink);
    text-shadow: 0 1px 2px rgb(0 0 0 / 0.35);
    text-wrap: balance;
  }
  /* An error message may run longer than the hint: smaller, three lines. */
  .hint.message {
    top: 47%;
    font-size: max(9px, calc(var(--bv-vis) * 0.074));
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  /* ------------------------------------------------------------------ */
  /* Skins                                                                */
  /* ------------------------------------------------------------------ */

  /* Glass: smoky translucent core, specular top-left, accent bloom
     bottom-right, rim light, grain. */
  .skin-glass .fill {
    background:
      radial-gradient(90% 64% at 22% -4%, rgb(255 255 255 / 0.5), rgb(255 255 255 / 0) 62%),
      radial-gradient(110% 80% at 105% 108%, rgb(var(--bv-glow-rgb) / 0.42), rgb(var(--bv-glow-rgb) / 0) 64%),
      linear-gradient(
        158deg,
        rgb(255 255 255 / 0.26) 0%,
        rgb(255 255 255 / 0.08) 40%,
        rgb(255 255 255 / 0.04) 64%,
        rgb(255 255 255 / 0.12) 100%
      ),
      rgb(22 25 34 / 0.44);
  }
  .skin-glass .sheen {
    background: linear-gradient(
      118deg,
      transparent 34%,
      rgb(255 255 255 / 0.13) 44%,
      rgb(255 255 255 / 0.02) 52%,
      transparent 60%
    );
  }

  :global([data-theme='light']) .skin-glass {
    /* Frosted white glass: engraved dark ink instead of white. */
    --bv-ink: rgb(22 30 56 / 0.78);
    --bv-ink-soft: rgb(22 30 56 / 0.46);
    --bv-shadow: 0 7px 12px -5px rgb(20 24 40 / 0.3), 0 2px 5px -1px rgb(20 24 40 / 0.16);
    --bv-shadow-lift: 0 10px 14px -6px rgb(20 24 40 / 0.34), 0 3px 7px -2px rgb(20 24 40 / 0.18);
  }
  :global([data-theme='light']) .skin-glass .glyph.mark {
    filter: drop-shadow(0 1px 0 rgb(255 255 255 / 0.7));
  }
  :global([data-theme='light']) .skin-glass .glyph.drop {
    filter: drop-shadow(0 0 4px rgb(var(--bv-glow-rgb) / 0.55)) drop-shadow(0 1px 0 rgb(255 255 255 / 0.7));
  }
  :global([data-theme='light']) .skin-glass .hint {
    text-shadow: 0 1px 0 rgb(255 255 255 / 0.6);
  }
  :global([data-theme='light']) .skin-glass .fill {
    background:
      radial-gradient(90% 64% at 22% -4%, rgb(255 255 255 / 0.7), rgb(255 255 255 / 0) 62%),
      radial-gradient(110% 80% at 105% 108%, rgb(var(--bv-glow-rgb) / 0.4), rgb(var(--bv-glow-rgb) / 0) 64%),
      linear-gradient(
        158deg,
        rgb(255 255 255 / 0.46) 0%,
        rgb(255 255 255 / 0.2) 42%,
        rgb(255 255 255 / 0.14) 66%,
        rgb(255 255 255 / 0.3) 100%
      ),
      rgb(120 130 160 / 0.26);
  }

  /* Neon: dark core, vivid accent rim with a second hue, scanlines. */
  .skin-neon {
    --bv-ink: rgb(var(--bv-glow-rgb) / 1);
    --bv-ink-soft: rgb(var(--bv-glow-rgb) / 0.9);
    --bv-rim: conic-gradient(
      from 210deg,
      rgb(var(--bv-glow-rgb) / 1),
      #ff4fd8,
      #34e7ff,
      rgb(var(--bv-glow-rgb) / 1)
    );
    --bv-rim-hot: conic-gradient(from 210deg, #ffffff, rgb(var(--bv-glow-rgb) / 1), #ff4fd8, #34e7ff, #ffffff);
    --bv-inset: inset 0 0 16px rgb(var(--bv-glow-rgb) / 0.38), inset 0 1px 0 rgb(255 255 255 / 0.12);
    --bv-shadow: 0 6px 12px -5px rgb(0 0 0 / 0.55), 0 0 7px rgb(var(--bv-glow-rgb) / 0.35);
    --bv-shadow-lift: 0 9px 14px -6px rgb(0 0 0 / 0.6), 0 0 10px rgb(var(--bv-glow-rgb) / 0.5);
  }
  .skin-neon .fill {
    background:
      repeating-linear-gradient(0deg, rgb(255 255 255 / 0.028) 0 1px, transparent 1px 4px),
      radial-gradient(120% 90% at 28% 12%, rgb(var(--bv-glow-rgb) / 0.2), rgb(var(--bv-glow-rgb) / 0) 60%),
      radial-gradient(90% 70% at 90% 100%, rgb(255 79 216 / 0.16), rgb(255 79 216 / 0) 62%),
      linear-gradient(160deg, rgb(23 20 40 / 0.96), rgb(8 8 16 / 0.97));
  }
  .skin-neon .rim {
    padding: 1.5px;
  }
  .skin-neon .grain {
    opacity: 0.05;
  }
  .skin-neon .glyph.mark {
    filter: drop-shadow(0 0 4px rgb(var(--bv-glow-rgb) / 0.9));
  }
  .skin-neon .icon {
    filter: drop-shadow(0 0 6px rgb(var(--bv-glow-rgb) / 0.55)) drop-shadow(0 2px 4px rgb(0 0 0 / 0.5));
  }

  /* Minimal: flat surface, hairline border, no gloss. */
  .skin-minimal {
    --bv-ink: var(--text, #f2f3f6);
    --bv-ink-soft: rgb(var(--text-rgb, 242 243 246) / 0.5);
    --bv-rim: linear-gradient(rgb(255 255 255 / 0.13), rgb(255 255 255 / 0.13));
    --bv-inset: inset 0 1px 0 rgb(255 255 255 / 0.05);
    --bv-shadow: 0 1px 2px rgb(0 0 0 / 0.3), 0 5px 10px -5px rgb(0 0 0 / 0.35);
    --bv-shadow-lift: 0 2px 3px rgb(0 0 0 / 0.3), 0 8px 13px -6px rgb(0 0 0 / 0.4);
  }
  .skin-minimal .fill {
    background: rgb(30 32 39 / 0.95);
  }
  .skin-minimal .grain,
  .skin-minimal .sheen {
    display: none;
  }
  .skin-minimal .glyph.mark {
    filter: none;
  }
  :global([data-theme='light']) .skin-minimal {
    --bv-rim: linear-gradient(rgb(0 0 0 / 0.11), rgb(0 0 0 / 0.11));
    --bv-inset: inset 0 1px 0 rgb(255 255 255 / 0.9);
    --bv-shadow: 0 1px 2px rgb(20 24 40 / 0.1), 0 5px 10px -5px rgb(20 24 40 / 0.2);
    --bv-shadow-lift: 0 2px 3px rgb(20 24 40 / 0.12), 0 8px 13px -6px rgb(20 24 40 / 0.24);
  }
  :global([data-theme='light']) .skin-minimal .fill {
    background: rgb(251 251 252 / 0.97);
  }
  :global([data-theme='light']) .skin-minimal .glyph.drop {
    filter: none;
  }

  /* Aurora: layered brand-colour gradients; static at rest, drifts while armed. */
  .skin-aurora {
    --bv-rim: linear-gradient(
      155deg,
      rgb(255 255 255 / 0.8) 0%,
      rgb(255 255 255 / 0.18) 35%,
      rgb(255 255 255 / 0.1) 65%,
      rgb(255 255 255 / 0.45) 100%
    );
    --bv-ink-soft: rgb(255 255 255 / 0.86);
  }
  .skin-aurora .fill {
    inset: -30%;
    background:
      radial-gradient(38% 34% at 30% 30%, rgb(124 92 255 / 0.95), rgb(124 92 255 / 0) 100%),
      radial-gradient(34% 32% at 72% 26%, rgb(31 200 227 / 0.9), rgb(31 200 227 / 0) 100%),
      radial-gradient(40% 36% at 70% 72%, rgb(255 122 182 / 0.9), rgb(255 122 182 / 0) 100%),
      radial-gradient(32% 30% at 28% 74%, rgb(255 211 110 / 0.85), rgb(255 211 110 / 0) 100%),
      linear-gradient(135deg, rgb(58 42 143 / 0.9), rgb(24 59 115 / 0.9));
    filter: saturate(1.1);
  }
  .skin-aurora .sheen {
    background:
      radial-gradient(90% 60% at 24% -6%, rgb(255 255 255 / 0.42), rgb(255 255 255 / 0) 60%),
      linear-gradient(180deg, rgb(255 255 255 / 0) 55%, rgb(10 10 30 / 0.18) 100%);
  }
  .skin-aurora .grain {
    opacity: 0.08;
  }

  /* Compatibility mode: everything opaque; the whole window is painted
     (DWM rounds its corners), so the margin gets a solid surface too. */
  .compat {
    background: var(--bg, #0e1014);
    border-radius: 8px;
  }
  .compat.skin-glass .fill {
    background:
      radial-gradient(90% 64% at 22% -4%, #4b5061, rgb(75 80 97 / 0) 62%),
      radial-gradient(110% 80% at 105% 108%, rgb(var(--bv-glow-rgb) / 0.5), rgb(var(--bv-glow-rgb) / 0) 64%),
      linear-gradient(158deg, #3a3e4b, #262a35 45%, #2c303c);
  }
  :global([data-theme='light']) .compat.skin-glass .fill {
    background:
      radial-gradient(90% 64% at 22% -4%, #ffffff, rgb(255 255 255 / 0) 62%),
      radial-gradient(110% 80% at 105% 108%, rgb(var(--bv-glow-rgb) / 0.45), rgb(var(--bv-glow-rgb) / 0) 64%),
      linear-gradient(158deg, #e9ecf3, #d6dae4 45%, #dfe2ea);
  }
  .compat.skin-neon .fill {
    background:
      radial-gradient(120% 90% at 28% 12%, rgb(var(--bv-glow-rgb) / 0.2), rgb(var(--bv-glow-rgb) / 0) 60%),
      linear-gradient(160deg, #17142a, #08080f);
  }
  .compat.skin-minimal .fill {
    background: var(--surface-2, #1b1e24);
  }
  .compat.skin-aurora .fill {
    background-color: #2a2f73;
  }
  .compat .grain {
    mix-blend-mode: normal;
    opacity: 0.03;
  }
  /* The window region is the visual box: the gulp, pop and shake move the
     content inside it instead of the box, the badge tucks into the corner
     (inside the rounded clip at every size) and hover lights the rim. */
  .compat.state-absorbing .body,
  .compat.state-celebrate .body,
  .compat.state-error .body {
    animation: none;
  }
  .compat.state-absorbing .content {
    animation: bv-absorb calc(var(--bv-absorb) * var(--motion-k)) linear both;
  }
  .compat.state-celebrate .content {
    animation: bv-pop calc(var(--bv-celebrate) * 0.6 * var(--motion-k)) var(--ease-standard) both;
  }
  .compat.state-error .content {
    animation: bv-shake calc(var(--bv-error) * var(--motion-k)) linear both;
  }
  .compat .badge {
    top: 7px;
    right: 7px;
    box-shadow: 0 0 0 1.5px rgb(255 255 255 / 0.9);
  }
  .compat.state-hover .rim.hot {
    opacity: 0.45;
  }

  /* ------------------------------------------------------------------ */
  /* States                                                               */
  /* ------------------------------------------------------------------ */
  .state-hover .shadow.lift,
  .state-flying .shadow.lift {
    opacity: 1;
  }

  .state-armed .glow,
  .state-armed .rim.hot {
    opacity: 1;
  }
  .state-armed .glyph.mark {
    opacity: 0;
    transform: scale(0.6) rotate(20deg);
  }
  .state-armed .glyph.drop {
    opacity: 1;
    transform: none;
  }
  .state-armed .glyphs {
    transform: translateY(2px);
  }
  .state-armed.skin-aurora .fill {
    animation: bv-aurora calc(9s * var(--motion-k)) linear infinite;
  }

  .state-absorbing .glow {
    opacity: 0.6;
  }
  .state-absorbing .rim.hot {
    opacity: 0.8;
  }
  .state-absorbing .body {
    animation: bv-absorb calc(var(--bv-absorb) * var(--motion-k)) linear both;
  }
  .state-absorbing .flash {
    animation: bv-flash calc(var(--bv-absorb) * var(--motion-k)) linear both;
  }

  .state-busy .content {
    opacity: 0.8;
  }

  .state-celebrate .body {
    animation: bv-pop calc(var(--bv-celebrate) * 0.6 * var(--motion-k)) var(--ease-standard) both;
  }
  .state-celebrate .glow {
    animation: bv-fade-out calc(var(--bv-celebrate) * var(--motion-fade-k)) var(--ease-decelerate) both;
  }

  .state-error {
    --bv-glow-rgb: var(--danger-rgb, 255 107 118);
  }
  .state-error .glow,
  .state-error .rim.hot {
    animation: bv-fade-out calc(var(--bv-error) * 1.6 * var(--motion-fade-k)) var(--ease-decelerate) both;
  }
  .state-error .body {
    animation: bv-shake calc(var(--bv-error) * var(--motion-k)) linear both;
  }

  /* Count badge */
  .badge {
    position: absolute;
    /* Stays inside the window even at the armed scale (1.08). */
    top: -5px;
    right: -5px;
    min-width: 24px;
    height: 24px;
    padding: 0 7px;
    display: grid;
    place-items: center;
    border-radius: 12px;
    background: linear-gradient(180deg, rgb(var(--bv-glow-rgb) / 1), rgb(var(--accent-dark-rgb, 90 56 214) / 1));
    color: #fff;
    font-size: 12.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    box-shadow:
      0 0 0 1.5px rgb(255 255 255 / 0.9),
      0 3px 6px rgb(0 0 0 / 0.35);
  }

  /* Particles drifting inward (only rendered while armed). */
  .particles {
    position: absolute;
    left: 50%;
    top: 50%;
  }
  .particles i {
    position: absolute;
    left: calc(var(--s) / -2);
    top: calc(var(--s) / -2);
    width: var(--s);
    height: var(--s);
    border-radius: 50%;
    background: rgb(255 255 255 / 0.95);
    box-shadow: 0 0 6px 1px rgb(var(--bv-glow-rgb) / 0.9);
    opacity: 0;
    animation: bv-inward calc(1400ms * var(--motion-k)) var(--ease-accelerate) var(--d) infinite;
  }

  /* Celebrate burst */
  .burst {
    position: absolute;
    inset: 0;
  }
  .ripple {
    position: absolute;
    inset: 0;
    border-radius: var(--bv-r);
    border: 2px solid rgb(var(--bv-glow-rgb) / 0.9);
    box-shadow: 0 0 10px rgb(var(--bv-glow-rgb) / 0.6);
    opacity: 0;
    animation: bv-ripple calc(var(--bv-celebrate) * 0.8 * var(--motion-k)) var(--ease-decelerate) both;
  }
  .ripple.second {
    border-color: rgb(255 255 255 / 0.7);
    animation-delay: calc(140ms * var(--motion-k));
  }
  .spark {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--z);
    height: var(--z);
    margin: calc(var(--z) / -2) 0 0 calc(var(--z) / -2);
    fill: #fff;
    filter: drop-shadow(0 0 3px rgb(var(--bv-glow-rgb) / 1));
    opacity: 0;
    animation: bv-spark calc(var(--bv-celebrate) * var(--motion-k)) var(--ease-decelerate) var(--d) both;
  }

  /* Busy ring (outside the scaled body, fixed to the window). */
  .ring {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    fill: none;
    stroke-width: 3;
    stroke-linecap: round;
  }
  .ring .track {
    stroke: rgb(255 255 255 / 0.16);
  }
  .ring .bar {
    stroke: rgb(var(--bv-glow-rgb) / 1);
    filter: drop-shadow(0 0 3px rgb(var(--bv-glow-rgb) / 0.8));
    transition: stroke-dasharray var(--dur-3) var(--ease-standard);
  }
  .ring.indeterminate .bar {
    animation: bv-orbit calc(1600ms * var(--motion-k)) linear infinite;
  }

  /* Reduced motion: nothing moves; state still reads through colour. */
  .reduced .body,
  .reduced .glyph,
  .reduced .glyphs {
    transition-property: opacity;
  }
  .reduced .body,
  .reduced .content,
  .reduced .glow,
  .reduced .rim.hot,
  .reduced .fill,
  .reduced .ripple,
  .reduced .flash,
  .reduced .ring .bar {
    animation: none !important;
  }
  .reduced.state-celebrate .ripple {
    opacity: 0.8;
    transform: scale(1.06);
  }
  .reduced.state-error .glow,
  .reduced.state-error .rim.hot {
    opacity: 1;
  }
  .reduced .ring.indeterminate .bar {
    stroke-dasharray: 100 0.001 !important;
    opacity: 0.6;
  }

  /* ------------------------------------------------------------------ */
  /* Keyframes                                                            */
  /* ------------------------------------------------------------------ */
  /* Inhale (0–42 %), impact squash at ABSORB_IMPACT_AT, springy settle. */
  @keyframes bv-absorb {
    0% {
      transform: scale(1.08);
      animation-timing-function: cubic-bezier(0.3, 0, 0.6, 1);
    }
    30% {
      transform: scale(1.11, 1.09);
      animation-timing-function: cubic-bezier(0.5, 0, 1, 1);
    }
    42% {
      transform: scale(1.16, 0.88);
      animation-timing-function: cubic-bezier(0, 0, 0.4, 1);
    }
    58% {
      transform: scale(0.93, 1.07);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    73% {
      transform: scale(1.035, 0.975);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    87% {
      transform: scale(0.992, 1.006);
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    100% {
      transform: none;
    }
  }
  @keyframes bv-flash {
    0%,
    38% {
      opacity: 0;
    }
    46% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes bv-pop {
    0% {
      transform: none;
    }
    35% {
      transform: scale(1.1);
    }
    65% {
      transform: scale(0.97);
    }
    100% {
      transform: none;
    }
  }
  @keyframes bv-fade-out {
    0% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes bv-shake {
    0%,
    100% {
      transform: none;
    }
    12% {
      transform: translateX(-8px) rotate(-1.5deg);
    }
    28% {
      transform: translateX(7px) rotate(1.2deg);
    }
    44% {
      transform: translateX(-5px) rotate(-0.8deg);
    }
    60% {
      transform: translateX(3.5px) rotate(0.5deg);
    }
    76% {
      transform: translateX(-1.5px);
    }
    90% {
      transform: translateX(0.5px);
    }
  }
  @keyframes bv-inward {
    0% {
      opacity: 0;
      transform: rotate(var(--a)) translateY(calc(var(--bv-vis) * -0.66)) scale(1);
    }
    25% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: rotate(var(--a)) translateY(calc(var(--bv-vis) * -0.16)) scale(0.35);
    }
  }
  @keyframes bv-ripple {
    0% {
      opacity: 0.95;
      transform: scale(0.96);
    }
    100% {
      opacity: 0;
      transform: scale(1.2);
    }
  }
  @keyframes bv-spark {
    0% {
      opacity: 0;
      transform: rotate(var(--a)) translateY(calc(var(--bv-vis) * -0.34)) scale(0.2) rotate(calc(var(--a) * -1));
    }
    30% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: rotate(var(--a)) translateY(calc(var(--bv-vis) * -0.6)) scale(1) rotate(calc(var(--a) * -1 + 90deg));
    }
  }
  @keyframes bv-orbit {
    to {
      stroke-dashoffset: -100;
    }
  }
  @keyframes bv-aurora {
    to {
      transform: rotate(360deg);
    }
  }
</style>
