import './app.css';

import { mount } from 'svelte';
import Presentation from './Presentation.svelte';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Muster presentation: #app mount target not found');
}

const presentation = mount(Presentation, { target });

export default presentation;
