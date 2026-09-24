<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';

  onMount(async () => {
    const boot = await commands.appBoot();
    if (boot.smoke) await commands.smokeReady({ window: 'editor', detail: navigator.userAgent });
  });
</script>

<main></main>

<style>
  :global(html, body) {
    margin: 0;
    background: transparent;
  }
</style>
