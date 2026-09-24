<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';

  let ready = $state(false);

  onMount(async () => {
    const boot = await commands.appBoot();
    ready = true;
    if (boot.smoke) await commands.smokeReady({ window: 'box', detail: navigator.userAgent });
  });
</script>

<div class="box" class:ready></div>

<style>
  :global(html, body) {
    margin: 0;
    background: transparent;
    overflow: hidden;
  }
  .box {
    position: absolute;
    inset: 14px;
    border-radius: 30px;
    background: rgba(40, 44, 60, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.18);
  }
</style>
