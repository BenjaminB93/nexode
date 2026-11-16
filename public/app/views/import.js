// @ts-check
// Page « Importer un historique » (TV Time, BetaSeries, Refract) : fichiers → Analyser → séries à confirmer → Importer → résultat.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { plural } from '../format.js';
import { listRowPlaceholder, navHeader, poster } from '../components.js';

// Applis prises en charge et fichiers à choisir dans leur export.
const SOURCES = /** @type {[string, string][]} */ ([
  ['TV Time', 'tracking-prod-records-v2.csv'],
  ['BetaSeries', 'episodes-….csv et series-….csv'],
  ['Refract', 'refract-backup-….zip'],
]);
const KIND = /** @type {Record<string, string>} */ ({ ambiguous: 'Plusieurs séries de ce titre', approximate: 'Titre approchant', missing: 'Introuvable' });

/** @param {any} m */
const exportLabel = (m) => m.title + (m.year ? ' (' + m.year + ')' : '');

/** @param {{ show: string, season: number, number: number }[]} missing */
function missingByShow(missing) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const e of missing) by.set(e.show, [...(by.get(e.show) || []), 'S' + e.season + 'E' + e.number]);
  return [...by].map(([show, eps]) => show + ' : ' + (eps.length > 6 ? eps.slice(0, 6).join(', ') + '… (' + eps.length + ')' : eps.join(', ')));
}

/**
 * Ligne de choix (un seul par série) : la ligne ouvre la fiche (onOpen), la pastille à droite choisit.
 * Sans onOpen, toute la ligne choisit.
 * @param {boolean} on @param {any} lead @param {string} title @param {string} sub @param {() => void} onPick @param {(() => void) | null} onOpen
 */
function choiceRow(on, lead, title, sub, onPick, onOpen) {
  const dot = html`<span aria-hidden="true" style="width: 22px; height: 22px; box-sizing: border-box; border-radius: 11px; border: 2px solid ${on ? 'var(--accent)' : 'var(--line-strong)'}; display: flex; align-items: center; justify-content: center">
    <span style="width: 10px; height: 10px; border-radius: 5px; background: var(--accent); transform: scale(${on ? 1 : 0}); transition: transform 0.15s ease"></span>
  </span>`;
  const plain = 'border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer';
  return html`<div style="min-height: 60px; display: flex; align-items: center">
    <button type="button" class="press" onClick=${onOpen || onPick} role=${onOpen ? undefined : 'radio'} aria-checked=${onOpen ? undefined : on ? 'true' : 'false'}
      style="flex: 1; min-width: 0; min-height: 60px; display: flex; align-items: center; gap: 12px; padding: 6px 4px; text-align: left; ${plain}">
      ${lead}
      <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
        <span class="ell" style="font-size: 14px; font-weight: 600">${title}</span>
        <span class="ell" style="font-size: 12px; color: var(--muted)">${sub}</span>
      </span>
      ${onOpen ? null : html`<span style="flex: none; width: 44px; display: flex; justify-content: center">${dot}</span>`}
    </button>
    ${onOpen ? html`<button type="button" role="radio" aria-checked=${on ? 'true' : 'false'} aria-label=${'Choisir ' + title} class="press" onClick=${onPick}
      style="flex: none; width: 44px; height: 60px; display: flex; align-items: center; justify-content: center; padding: 0; ${plain}">${dot}</button>` : null}
  </div>`;
}

/** Une série à confirmer. @param {import('../app.js').App} app @param {import('../app.js').ImportState} x @param {any} m */
function matchCard(app, x, m) {
  const cur = x.choices[m.key] ?? null;
  const cands = [...m.candidates, ...(x.extra[m.key] || []).filter((/** @type {any} */ c) => !m.candidates.some((/** @type {any} */ k) => k.id === c.id))];
  const searching = x.searchFor === m.key;
  const candSub = (/** @type {any} */ c) => [c.year, c.seasonCount ? plural(c.seasonCount, 'saison', 'saisons') : null,
    m.episodes && c.hits !== undefined ? c.hits + '/' + m.episodes + ' épisodes vus retrouvés' : null].filter(Boolean).join(' · ');
  return html`<section class="group" style="padding: 10px 12px; display: flex; flex-direction: column; gap: 2px">
    <span style="display: flex; flex-direction: column; gap: 2px; padding: 0 4px 6px">
      <span style="font-size: 15px; font-weight: 700">${exportLabel(m)}</span>
      <span style="font-size: 12px; color: var(--muted)">${KIND[m.kind]}${m.episodes ? ' · ' + plural(m.episodes, 'épisode vu', 'épisodes vus') : ''}</span>
    </span>
    <div role="radiogroup" aria-label=${exportLabel(m)}>
      ${cands.map((/** @type {any} */ c) => choiceRow(cur === c.id, poster(c.posterPath, 34, 51, 5, 'flex: none'), c.name, candSub(c), () => app.chooseImport(m.key, c.id), () => app.openShow(c)))}
      ${choiceRow(cur === null, html`<span style="flex: none; width: 34px; height: 51px; display: flex; align-items: center; justify-content: center; color: var(--faint)">—</span>`,
        'Ne pas importer', '', () => app.chooseImport(m.key, null), null)}
    </div>
    ${searching ? html`<div style="display: flex; flex-direction: column; gap: 6px; padding-top: 6px">
      <label style="height: 44px; box-sizing: border-box; border-radius: 12px; background: var(--card); border: 1px solid var(--accent); display: flex; align-items: center; gap: 10px; padding: 0 12px">
        ${I.search('var(--muted)')}
        <input type="search" autofocus value=${x.searchQ} placeholder="Titre de la série" aria-label="Chercher une série"
          autocomplete="off" autocapitalize="off" spellcheck=${false} enterkeyhint="search"
          onInput=${(/** @type {Event} */ ev) => app.searchImport(/** @type {HTMLInputElement} */ (ev.currentTarget).value)}
          style="flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--fg); font: 500 16px var(--text)" />
      </label>
      ${(x.searchResults || []).map((/** @type {any} */ r) => choiceRow(false, poster(r.posterPath, 34, 51, 5, 'flex: none'), r.name, r.year ? String(r.year) : '', () => app.pickImportSearch(m.key, r), () => app.openShow(r)))}
    </div>` : html`<button type="button" class="press" onClick=${() => app.openImportSearch(m.key, m.title)}
      style="align-self: flex-start; height: 40px; border: 0; background: transparent; color: var(--accent); font: 600 13px var(--text); padding: 0 4px; cursor: pointer">Chercher une autre série</button>`}
  </section>`;
}

/** @param {import('../app.js').App} app @param {import('../app.js').ImportState} x */
export function viewImport(app, x) {
  const busy = x.step === 'reading' || x.step === 'analyzing' || x.step === 'importing';
  const muted = (/** @type {any} */ t) => html`<span style="font-size: 13px; line-height: 1.5; color: var(--muted)">${t}</span>`;
  /** @type {any} */
  let body;
  if (x.step === 'done' && x.report) {
    const { shows, episodes, relations } = x.report;
    const list = (/** @type {string} */ title, /** @type {string[]} */ items) => (items.length ? html`<section style="display: flex; flex-direction: column; gap: 4px">
      <h2 class="eyebrow">${title} · ${items.length}</h2>${items.map((s) => html`<span style="font-size: 13px; color: var(--soft)">${s}</span>`)}</section>` : null);
    body = html`
      <section class="group" style="padding: 14px; display: flex; flex-direction: column; gap: 6px">
        <span style="font-size: 17px; font-weight: 700">${plural(episodes.imported, 'épisode importé', 'épisodes importés')}</span>
        ${muted((episodes.alreadySeen ? plural(episodes.alreadySeen, 'déjà vu', 'déjà vus') + ' · ' : '') + plural(shows.imported, 'série', 'séries')
          + ' · ' + plural(relations.followed, 'suivie', 'suivies') + ', ' + relations.shelved + ' de côté' + (relations.kept ? ', ' + relations.kept + ' déjà dans Mes séries' : ''))}
      </section>
      ${list('Séries non importées', shows.skipped)}
      ${list('Épisodes non retrouvés', missingByShow(episodes.missing))}
      <button type="button" class="btn btn-primary press" style="flex: none" onClick=${() => app.closeImport()}>Terminé</button>`;
  } else if (x.analysis && (x.step === 'review' || x.step === 'importing')) {
    const toCheck = x.analysis.matches.filter((/** @type {any} */ m) => m.kind !== 'sure');
    const sure = x.analysis.matches.filter((/** @type {any} */ m) => m.kind === 'sure');
    body = html`
      ${muted(plural(x.analysis.watches, 'épisode vu', 'épisodes vus') + ' · ' + plural(sure.length, 'série reconnue', 'séries reconnues') + (toCheck.length ? ' · ' + toCheck.length + ' à confirmer' : ''))}
      ${toCheck.length ? html`<h2 class="eyebrow">À confirmer · ${toCheck.length}</h2>${toCheck.map((/** @type {any} */ m) => matchCard(app, x, m))}` : null}
      <button type="button" class="press" aria-expanded=${x.showSure ? 'true' : 'false'} onClick=${() => app.setImportState({ showSure: !x.showSure })}
        style="flex: none; display: flex; align-items: center; justify-content: space-between; height: 40px; border: 0; background: transparent; color: inherit; font: inherit; padding: 0 4px; cursor: pointer">
        <span class="eyebrow">Reconnues · ${sure.length}</span>
        <span style="display: flex; color: var(--dim); transform: rotate(${x.showSure ? 90 : 0}deg); transition: transform 0.15s ease">${I.chev()}</span>
      </button>
      ${x.showSure ? html`<section class="group" style="padding: 6px 12px">${sure.map((/** @type {any} */ m) => {
        const c = m.candidates[0];
        return html`<div style="min-height: 44px; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 4px">
          <span class="ell" style="font-size: 13px; font-weight: 600">${c ? c.name : exportLabel(m)}</span>
          <span class="ell" style="font-size: 12px; color: var(--muted)">${[c && c.year, m.episodes ? plural(m.episodes, 'épisode', 'épisodes') : null].filter(Boolean).join(' · ')}${c && c.name !== m.title ? ' · ' + exportLabel(m) : ''}</span>
        </div>`;
      })}</section>` : null}
      ${x.error ? html`<span style="font-size: 13px; color: var(--danger)">${x.error}</span>` : null}
      <button type="button" class="btn btn-primary press" style="flex: none; opacity: ${busy ? 0.45 : 1}" disabled=${busy} onClick=${() => app.runImport()}>
        ${x.step === 'importing' ? 'Import en cours…' : 'Importer'}</button>`;
  } else {
    body = html`
      <div style="display: flex; flex-direction: column; gap: 4px">${SOURCES.map(([app, files]) => html`<div style="font-size: 13px; line-height: 1.4">
        <span style="font-weight: 600">${app}</span><span style="color: var(--muted)"> : ${files}</span></div>`)}</div>
      <input id="import-files" type="file" accept=".csv,text/csv,.zip,application/zip" multiple hidden onChange=${(/** @type {Event} */ ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.currentTarget);
        if (input.files && input.files.length) app.pickImportFiles(input.files);
        input.value = '';
      }} />
      <button type="button" class="btn btn-ghost press" style="flex: none" disabled=${busy} onClick=${() => { const el = document.getElementById('import-files'); if (el) el.click(); }}>Choisir les fichiers</button>
      ${x.files && x.files.length ? html`<section class="group" style="padding: 6px 12px">${x.files.map((f) => html`<div style="min-height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 4px">
        <span class="ell" style="flex: 1; min-width: 0; font-size: 13px">${f.name}</span>
        <span style="flex: none; font-size: 12px; color: var(--muted)">${Math.max(1, Math.round(('text' in f ? f.text.length : f.base64.length * 3 / 4) / 1024))} Ko</span>
      </div>`)}</section>` : null}
      ${x.step === 'analyzing' ? html`${muted('Analyse en cours…')}<div style="display: flex; flex-direction: column; gap: 2px">${listRowPlaceholder()}${listRowPlaceholder()}</div>` : null}
      ${x.error ? html`<span style="font-size: 13px; color: var(--danger)">${x.error}</span>` : null}
      <button type="button" class="btn btn-primary press" style="flex: none; opacity: ${x.files && !busy ? 1 : 0.45}" disabled=${!x.files || busy} onClick=${() => app.analyzeImport()}>Analyser</button>`;
  }
  return html`
    <div class="screen">
      ${navHeader(() => app.back(), [], 'Importer un historique', true)}
      <div class="scroll body" style="gap: 14px">${body}</div>
    </div>`;
}
