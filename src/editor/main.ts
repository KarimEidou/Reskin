if (__E2E__) (await import('../testing/tauri-mock')).install('editor');

import { mount } from 'svelte';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
