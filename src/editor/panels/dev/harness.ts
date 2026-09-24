// Entry of the panels harness page (see harness.html).

if (__E2E__) (await import('../../../testing/tauri-mock')).install('editor');

const { mount } = await import('svelte');
const { default: Harness } = await import('./Harness.svelte');

mount(Harness, { target: document.getElementById('app')! });

export {};
