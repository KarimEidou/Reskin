import { mount } from 'svelte';
import Box from './Box.svelte';

if (__E2E__) (await import('../testing/tauri-mock')).install('box');

mount(Box, { target: document.getElementById('app')! });
