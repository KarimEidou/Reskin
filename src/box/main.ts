if (__E2E__) (await import('../testing/tauri-mock')).install('box');

import { mount } from 'svelte';
import Box from './Box.svelte';

mount(Box, { target: document.getElementById('app')! });
