<!--
  First run: three short illustrated steps (drop → design → apply) that
  animate once, then "Got it" collapses the editor into the box, which shows
  its "drag a shortcut onto me" hint. Onboarding counts as done once the
  welcome has been shown, so closing it any other way (×, Escape) does not
  bring it back at the next start.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { onMount } from 'svelte';
  import { settings, updateSettings } from '$lib/settings/store.svelte';
  import Button from '$lib/ui/Button.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import LogoMark from '../chrome/LogoMark.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import { errorText } from '../state/session.svelte';

  const session = getSession();
  const shell = getShell();
  let closing = $state(false);

  const STEPS = [
    { title: 'Drop a shortcut', text: 'Drag any desktop shortcut, folder or image onto the box.' },
    { title: 'Make it yours', text: 'Paint, recolour, add a backdrop or a style preset — every step can be undone.' },
    { title: 'Save & Apply', text: 'Your desktop icon changes right away. Undo or restore the original any time.' },
  ] as const;

  onMount(() => {
    if (settings().onboarded) return;
    updateSettings({ onboarded: true }).catch((e: unknown) => console.error('[welcome] could not save onboarded', e));
  });

  async function done(): Promise<void> {
    closing = true;
    try {
      await updateSettings({ onboarded: true });
    } catch (e) {
      toast({ message: `Could not save settings: ${errorText(e)}`, kind: 'error' });
    }
    try {
      await session.requestClose();
    } catch (e) {
      toast({ message: `Could not close the editor: ${errorText(e)}`, kind: 'error' });
    } finally {
      closing = false;
    }
  }
</script>

<section class="welcome" aria-labelledby="welcome-title" data-testid="welcome-view">
  <!-- Replayed on every open so the steps animate when you see them. -->
  {#key shell.openEpoch}
    <header data-stagger>
      <LogoMark size={52} />
      <h1 id="welcome-title">Welcome to Reskin</h1>
      <p>Give any desktop icon a new look in three steps.</p>
    </header>

    <ol class="steps" data-stagger>
      {#each STEPS as step, i (step.title)}
        <li class="step" style:--i={i}>
          <div class="art" aria-hidden="true">
            {#if i === 0}
              <svg viewBox="0 0 160 110">
                <defs>
                  <linearGradient id="wg-app" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#ff9a5c" />
                    <stop offset="1" stop-color="#ff5c8a" />
                  </linearGradient>
                </defs>
                <rect class="glass" x="52" y="46" width="56" height="56" rx="15" />
                <rect class="glass-rim" x="52" y="46" width="56" height="56" rx="15" />
                <g class="drop-tile">
                  <rect x="64" y="10" width="32" height="32" rx="8" fill="url(#wg-app)" />
                  <path d="M73 26h14M80 19v14" stroke="#fff" stroke-width="3" stroke-linecap="round" />
                </g>
                <path class="cursor" d="M104 20l14 34 5-13 13-5z" />
              </svg>
            {:else if i === 1}
              <svg viewBox="0 0 160 110">
                <defs>
                  <linearGradient id="wg-stroke" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stop-color="#ff7ab6" />
                    <stop offset="1" stop-color="#ffd36e" />
                  </linearGradient>
                  <pattern id="wg-check" width="10" height="10" patternUnits="userSpaceOnUse">
                    <rect width="10" height="10" class="check-a" />
                    <rect width="5" height="5" class="check-b" />
                    <rect x="5" y="5" width="5" height="5" class="check-b" />
                  </pattern>
                </defs>
                <rect x="44" y="12" width="72" height="72" rx="10" fill="url(#wg-check)" class="canvas" />
                <path class="stroke" d="M54 66c14-2 22-12 30-24s18-22 30-24" stroke="url(#wg-stroke)" />
                <g class="swatches">
                  <circle cx="62" cy="98" r="6" fill="#7c5cff" />
                  <circle cx="80" cy="98" r="6" fill="#1fc8e3" />
                  <circle cx="98" cy="98" r="6" fill="#ff7ab6" />
                </g>
              </svg>
            {:else}
              <svg viewBox="0 0 160 110">
                <defs>
                  <linearGradient id="wg-new" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#7c5cff" />
                    <stop offset="0.55" stop-color="#4f7dff" />
                    <stop offset="1" stop-color="#1fc8e3" />
                  </linearGradient>
                </defs>
                <rect class="old" x="60" y="18" width="40" height="40" rx="9" />
                <g class="new">
                  <rect x="60" y="18" width="40" height="40" rx="10" fill="url(#wg-new)" />
                  <path d="M80 27c.9 6.4 2.5 8 9 9-6.5.9-8.1 2.5-9 9-.9-6.5-2.5-8.1-9-9 6.5-1 8.1-2.6 9-9Z" fill="#fff" />
                </g>
                <rect class="label" x="56" y="66" width="48" height="8" rx="4" />
                <g class="sparks">
                  <path d="M52 16l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
                  <path d="M110 44l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" />
                  <path d="M108 10l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
                </g>
              </svg>
            {/if}
          </div>
          <span class="num">{i + 1}</span>
          <h2>{step.title}</h2>
          <p>{step.text}</p>
        </li>
      {/each}
    </ol>

    <footer data-stagger>
      <Button variant="primary" size="lg" iconRight={ArrowRight} loading={closing} onclick={done} data-testid="welcome-done">
        Got it
      </Button>
      <span class="hint">The box will wait on your desktop — drop a shortcut onto it.</span>
    </footer>
  {/key}
</section>

<style>
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-8);
    flex: 1;
    min-height: 0;
    padding: var(--space-6) var(--space-8);
    overflow: auto;
    text-align: center;
  }
  header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  h1 {
    margin: var(--space-2) 0 0;
    font-family: var(--font-display);
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  header p {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-base);
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 240px));
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1-5);
    padding: var(--space-4) var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(var(--bg-rgb) / 0.3);
    animation: step-in calc(420ms * var(--motion-k)) var(--ease-decelerate) both;
    animation-delay: calc((120ms + var(--i) * 110ms) * var(--motion-k));
  }
  :global([data-theme='light']) .step {
    background: rgb(255 255 255 / 0.6);
  }
  .art {
    width: 100%;
    aspect-ratio: 16 / 11;
    margin-bottom: var(--space-2);
    border-radius: var(--radius-md);
    background:
      radial-gradient(80% 90% at 50% 100%, rgb(var(--accent-rgb) / 0.14), transparent 70%),
      var(--shell-well);
    overflow: hidden;
  }
  .art svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .num {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
  }
  .step h2 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }
  .step p {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
  }

  footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  .hint {
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  /* ---- illustrations (each plays once) ---------------------------------- */
  .glass {
    fill: rgb(255 255 255 / 0.1);
  }
  .glass-rim {
    fill: none;
    stroke: rgb(255 255 255 / 0.45);
    stroke-width: 1.5;
  }
  :global([data-theme='light']) .glass {
    fill: rgb(80 90 130 / 0.14);
  }
  :global([data-theme='light']) .glass-rim {
    stroke: rgb(40 50 90 / 0.3);
  }
  .drop-tile {
    transform-box: fill-box;
    transform-origin: 50% 50%;
    animation: tile-drop calc(900ms * var(--motion-k)) var(--ease-emphasized) both;
    animation-delay: calc((500ms + var(--i) * 110ms) * var(--motion-k));
  }
  .cursor {
    fill: var(--text);
    stroke: var(--surface-sunken);
    stroke-width: 2;
    stroke-linejoin: round;
    animation: cursor-fade calc(900ms * var(--motion-k)) linear both;
    animation-delay: calc(500ms * var(--motion-k));
  }

  .canvas {
    stroke: var(--border-strong);
  }
  .check-a {
    fill: var(--checker-a);
  }
  .check-b {
    fill: var(--checker-b);
  }
  .stroke {
    fill: none;
    stroke-width: 9;
    stroke-linecap: round;
    stroke-dasharray: 120;
    animation: draw calc(900ms * var(--motion-k)) var(--ease-standard) both;
    animation-delay: calc((600ms + var(--i) * 110ms) * var(--motion-k));
  }

  .old {
    fill: var(--text-3);
    opacity: 0.5;
    animation: fade-out calc(400ms * var(--motion-k)) linear both;
    animation-delay: calc(1000ms * var(--motion-k));
  }
  .new {
    transform-box: fill-box;
    transform-origin: 50% 50%;
    animation: pop-in calc(520ms * var(--motion-k)) var(--ease-overshoot) both;
    animation-delay: calc(1050ms * var(--motion-k));
  }
  .label {
    fill: var(--text-3);
    opacity: 0.45;
  }
  .sparks path {
    fill: #ffd36e;
    transform-box: fill-box;
    transform-origin: 50% 50%;
    animation: sparkle calc(700ms * var(--motion-k)) var(--ease-decelerate) both;
    animation-delay: calc(1250ms * var(--motion-k));
  }

  @keyframes step-in {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }
  @keyframes tile-drop {
    0% {
      transform: translate(-30px, -6px) rotate(-12deg);
    }
    60% {
      transform: translate(0, 40px) rotate(0deg) scale(0.9);
    }
    100% {
      transform: translate(0, 48px) scale(0.84);
    }
  }
  @keyframes cursor-fade {
    0% {
      opacity: 1;
      transform: translate(-30px, -6px);
    }
    60% {
      opacity: 1;
      transform: translate(0, 0);
    }
    100% {
      opacity: 0;
      transform: translate(6px, 4px);
    }
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 120;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes fade-out {
    to {
      opacity: 0;
    }
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
  }
  @keyframes sparkle {
    0% {
      opacity: 0;
      transform: scale(0.2);
    }
    40% {
      opacity: 1;
    }
    100% {
      opacity: 0.9;
      transform: scale(1);
    }
  }
</style>
