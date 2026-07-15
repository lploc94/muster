import './app.css';

// vscode-elements — import only the components we use (tree-shakeable).
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-textarea/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-single-select/index.js';
import '@vscode-elements/elements/dist/vscode-option/index.js';
import '@vscode-elements/elements/dist/vscode-radio-group/index.js';
import '@vscode-elements/elements/dist/vscode-radio/index.js';
import '@vscode-elements/elements/dist/vscode-badge/index.js';

import { mount } from 'svelte';
import App from './App.svelte';
import { installCustomScrollbars } from './lib/scrollbar';

// Opaque, always-visible scrollbars across the whole extension (light DOM +
// web-component shadow roots). Must run after the elements above are defined so
// their shadow roots exist when adopted.
installCustomScrollbars();

const target = document.getElementById('app');
if (!target) {
  throw new Error('Muster webview: #app mount target not found');
}

const app = mount(App, { target });

export default app;
