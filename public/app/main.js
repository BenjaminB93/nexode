// @ts-check
// Démarrage : monte l'appli dans #app.
import { html, render } from '../vendor/htm-preact-3.1.1.js';
import { App } from './app.js';

const root = document.getElementById('app');
if (root) render(html`<${App} />`, root);
