<!-- The Reskin mark (app-icon.svg, simplified for small sizes). Decorative. -->
<script lang="ts">
  interface Props {
    /** Size in px. */
    size?: number;
  }

  let { size = 22 }: Props = $props();
  const id = $props.id();
</script>

<svg class="logo" width={size} height={size} viewBox="3 3 42 42" aria-hidden="true">
  <defs>
    <linearGradient id="{id}-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff" />
      <stop offset="0.55" stop-color="#4f7dff" />
      <stop offset="1" stop-color="#1fc8e3" />
    </linearGradient>
    <linearGradient id="{id}-glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55" />
      <stop offset="1" stop-color="#fff" stop-opacity="0.12" />
    </linearGradient>
    <linearGradient id="{id}-stroke" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#ff7ab6" />
      <stop offset="1" stop-color="#ffd36e" />
    </linearGradient>
  </defs>
  <path d="M24 3c14.06 0 21 6.94 21 21s-6.94 21-21 21S3 38.06 3 24 9.94 3 24 3z" fill="url(#{id}-bg)" />
  <rect
    x="12.3"
    y="12.3"
    width="23.4"
    height="23.4"
    rx="6"
    fill="url(#{id}-glass)"
    stroke="#fff"
    stroke-opacity="0.75"
    stroke-width="1.1"
  />
  <path
    d="M14.9 30c4.5-.56 7.03-3.28 9.66-7.03s5.62-7.03 10.03-7.97"
    fill="none"
    stroke="url(#{id}-stroke)"
    stroke-width="3.2"
    stroke-linecap="round"
  />
  <path d="M33.75 9.4l1.2 3.1 3.1 1.2-3.1 1.2-1.2 3.1-1.2-3.1-3.1-1.2 3.1-1.2z" fill="#fff" />
</svg>

<style>
  .logo {
    display: block;
    flex: none;
    filter: drop-shadow(0 1px 1.5px rgb(40 30 120 / 0.3));
  }
</style>
