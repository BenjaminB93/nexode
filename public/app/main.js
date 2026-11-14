// @ts-check
// Démarrage : monte l'appli dans #app, enregistre le service worker (notifications).
import { html, render } from '../vendor/htm-preact-3.1.1.js';
import { App } from './app.js';
import { registerWorker } from './push.js';

const root = document.getElementById('app');
if (root) render(html`<${App} />`, root);
registerWorker();
