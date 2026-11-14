// @ts-check
import { html } from '../vendor/htm-preact-3.1.1.js';

/** Icônes (traits SVG en currentColor). */
export const I = {
  /** @param {string | null} [c] couleur @param {number} [w] taille @param {number} [sw] épaisseur */
  check: (c, w, sw) => html`<svg width=${w || 22} height=${w || 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" style=${c ? 'color: ' + c : null} stroke-width=${sw || 3} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`,
  back: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>`,
  chev: () => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="color: var(--dim)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>`,
  tv: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2"></rect><path d="m10 8 5 3-5 3z"></path><path d="M8 21h8"></path></svg>`,
  box: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>`,
  /** @param {string} [c] */
  search: (c) => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" style=${c ? 'color: ' + c : null} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`,
  user: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg>`,
  down: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`,
};
