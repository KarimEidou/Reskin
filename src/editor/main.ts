import { mount } from 'svelte';
import App from './App.svelte';

if (__E2E__) (await import('../testing/tauri-mock')).install('editor');

mount(App, { target: document.getElementById('app')! });
