import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// vscode-elements are interactive web components, but Svelte's a11y linter
// treats unknown custom elements as static — silence only those two
// false-positive rules (real HTML a11y warnings still surface).
const IGNORED_A11Y = new Set([
  'a11y_no_static_element_interactions',
  'a11y_click_events_have_key_events',
]);

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter: (warning) => !IGNORED_A11Y.has(warning.code),
  },
};
