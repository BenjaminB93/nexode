// @ts-check
// Onglet « Mes séries » : recherche TMDB et séries suivies, même présentation de ligne dans les deux zones.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { CHIPS, showMeta } from '../format.js';
import { loadError, phLine, poster } from '../components.js';

// Ligne réservée même vide : un élément conditionnel garde sa place.
const NBSP = '\u00a0';

/** @param {import('../app.js').App} app @param {any} st */
export function viewSeries(app, st) {
  const q = st.search.q;
  const searching = q.trim().length >= 2;
  const rows = st.mine ? st.mine.rows.filter((/** @type {any} */ r) => r.relation !== 'none') : null;

  /** @param {any} r */
  const followButton = (r) => {
    const on = r.relation !== 'none';
    return html`<button type="button" class="press" onClick=${() => app.setRelation(r.id, on ? 'none' : 'on')}
      style="flex: none; height: 44px; min-width: 92px; padding: 0 12px; border-radius: 12px; border: ${on ? '1px solid var(--ok-line)' : '0'}; background: ${on ? 'var(--ok-bg)' : 'var(--accent)'}; color: ${on ? 'var(--ok-fg)' : 'var(--on-accent)'}; font: 700 13px var(--text); cursor: pointer">${on ? 'Suivie' : '+ Suivre'}</button>`;
  };
  /** @param {any} r */
  const statusChip = (r) => {
    const c = CHIPS[r.status] || CHIPS.encours;
    return html`<span style="flex: none; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: ${c[1]}; color: ${c[2]}">${c[0]}</span>`;
  };

  let results = null;
  if (searching) {
    const list = st.search.results;
    results = html`<section aria-label="Résultats de recherche" style="display: flex; flex-direction: column; gap: 8px">
      <h2 class="eyebrow">Résultats · TMDB</h2>
      ${list ? list.map((/** @type {any} */ r) => seriesRow(app, r, followButton(r)))
        : st.search.error ? html`<p class="note">Recherche indisponible</p>`
        : [0, 1, 2].map((i) => placeholderRow(i))}
      ${list && !list.length && !st.search.loading ? html`<p class="note">Aucun résultat</p>` : null}
    </section>`;
  }

  return html`
    <div class="screen">
      <header class="hdr" style="height: 124px; flex-direction: column; align-items: stretch; justify-content: center; gap: 12px; padding: 14px 16px 12px">
        <h1 class="h1" style="margin: 0 4px">Mes séries</h1>
        <label style="height: 48px; box-sizing: border-box; border-radius: 14px; background: var(--card); border: 1px solid var(--accent); display: flex; align-items: center; gap: 10px; padding: 0 14px">
          ${I.search('var(--muted)')}
          <input id="recherche" type="search" aria-label="Rechercher une série" value=${q} onInput=${app.onSearchInput} placeholder="Rechercher une série à suivre"
            autocomplete="off" autocapitalize="off" spellcheck=${false} enterkeyhint="search"
            style="flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--fg); font: 500 16px var(--text)" />
        </label>
      </header>
      <div class="scroll body" style="top: 124px; gap: 22px">
        ${results}
        <section aria-label="Séries suivies" style="display: flex; flex-direction: column; gap: 2px">
          ${rows
            ? html`<h2 class="eyebrow" style="margin-bottom: 6px">Suivies · ${rows.length}</h2>${rows.map((/** @type {any} */ r) => seriesRow(app, r, statusChip(r)))}`
            : st.errs.mine ? loadError(() => app.loadMine()) : null}
        </section>
        <p style="margin: 8px 0 0; font-size: 11px; line-height: 1.5; color: var(--faint)">Données et affiches : TMDB. Ce produit utilise l’API TMDB mais n’est ni approuvé ni certifié par TMDB.</p>
      </div>
    </div>`;
}

/**
 * Ligne de série commune aux résultats de recherche et aux séries suivies : même affiche, même structure.
 * La 3e ligne (« x/y vus ») garde sa place même vide.
 * @param {import('../app.js').App} app @param {any} r @param {any} right
 */
function seriesRow(app, r, right) {
  return html`<div key=${r.id} style="display: flex; flex-direction: column">
    <div style="min-height: 72px; display: flex; align-items: center; gap: 10px">
      <button type="button" onClick=${() => app.openShow(r)} style="flex: 1; min-width: 0; min-height: 72px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; display: flex; align-items: center; gap: 12px; padding: 0; cursor: pointer">
        ${poster(r.posterPath, 40, 60, 6)}
        <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
          <span class="ell" style="font-size: 15px; font-weight: 600">${r.name}</span>
          <span class="ell" style="font-size: 12px; color: var(--muted)">${showMeta(r) || NBSP}</span>
          <span class="ell" style="font-size: 12px; color: var(--muted)">${r.seen ? r.seen + '/' + r.total + ' vus' : NBSP}</span>
        </span>
      </button>
      ${right}
    </div>
  </div>`;
}

/** Ligne réservée pendant la première recherche. @param {number} i */
function placeholderRow(i) {
  return html`<div key=${'ph' + i} aria-hidden="true" style="min-height: 72px; display: flex; align-items: center; gap: 12px">
    ${poster(null, 40, 60, 6)}
    <span style="flex: 1; display: flex; flex-direction: column; gap: 8px">${phLine('60%', 14)}${phLine('40%')}</span>
  </div>`;
}
