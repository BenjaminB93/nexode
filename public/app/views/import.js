// @ts-check
// Import d'un historique TV Time / BetaSeries : choix des fichiers, bilan (essai à blanc), puis import.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { plural } from '../format.js';
import { sheet } from '../components.js';

const FORMATS = /** @type {Record<string, string>} */ ({
  tvtime: 'TV Time',
  'betaseries-episodes': 'BetaSeries, épisodes',
  'betaseries-series': 'BetaSeries, séries',
});

/** @param {{ show: string, season: number, number: number }[]} missing */
function missingByShow(missing) {
  /** @type {Map<string, string[]>} */
  const m = new Map();
  for (const e of missing) m.set(e.show, [...(m.get(e.show) || []), 'S' + e.season + 'E' + e.number]);
  return [...m].map(([show, eps]) => show + ' : ' + (eps.length > 6 ? eps.slice(0, 6).join(', ') + '… (' + eps.length + ')' : eps.join(', ')));
}

/** @param {any} r réponse de POST /api/import */
function reportView(r) {
  const { shows, episodes, relations } = r.report;
  const line = (/** @type {any} */ t, color = 'var(--soft)') => html`<span style="color: ${color}">${t}</span>`;
  const list = (/** @type {string} */ title, /** @type {string[]} */ items) => items.length ? html`
    <span style="margin-top: 6px; color: var(--muted)">${title}</span>
    ${items.map((x) => html`<span style="padding-left: 10px; color: var(--faint)">${x}</span>`)}` : null;
  return html`
    ${r.files.map((/** @type {any} */ f) => line(f.name + ' · ' + (FORMATS[f.format] || f.format), 'var(--muted)'))}
    ${line(html`<b style="color: var(--fg)">${plural(episodes.imported, 'épisode', 'épisodes')}</b> à importer${episodes.alreadySeen ? ' · ' + plural(episodes.alreadySeen, 'déjà vu', 'déjà vus') : ''}`)}
    ${line(plural(relations.followed, 'série suivie', 'séries suivies') + ' · ' + relations.shelved + ' de côté' + (relations.kept ? ' · ' + relations.kept + ' déjà dans tes séries' : ''))}
    ${list('Séries non retrouvées', shows.missing)}
    ${list('Titres rapprochés', shows.approximate.map((/** @type {any} */ a) => a.title + ' → ' + a.matched))}
    ${list(plural(episodes.missing.length, 'épisode non retrouvé', 'épisodes non retrouvés'), missingByShow(episodes.missing))}`;
}

/** @param {import('../app.js').App} app @param {import('../app.js').ImportSheet} x */
export function importSheetView(app, x) {
  const busy = x.step === 'reading' || x.step === 'analyzing' || x.step === 'importing';
  const ready = x.step === 'preview' && x.result && x.result.report.episodes.imported + x.result.report.relations.followed + x.result.report.relations.shelved > 0;
  const status = x.error ? html`<span style="color: var(--danger)">${x.error}</span>`
    : x.step === 'reading' || x.step === 'analyzing' ? html`<span style="color: var(--muted)">Analyse en cours…</span>`
    : x.result ? reportView(x.result)
    : html`<span style="color: var(--faint)">Aucun fichier choisi</span>`;
  return sheet('Importer un historique', 'TV Time : tracking-prod-records-v2.csv · BetaSeries : episodes-….csv et series-….csv', () => { if (!busy) app.setState({ importSheet: null }); }, html`
    <input id="import-files" type="file" accept=".csv,text/csv" multiple hidden onChange=${(/** @type {Event} */ ev) => {
      const input = /** @type {HTMLInputElement} */ (ev.currentTarget);
      if (input.files && input.files.length) app.pickImportFiles(input.files);
      input.value = '';
    }} />
    <button type="button" class="btn btn-ghost press" disabled=${busy} onClick=${() => { const el = document.getElementById('import-files'); if (el) el.click(); }}>Choisir les fichiers</button>
    <div style="height: 240px; overflow-y: auto; box-sizing: border-box; border-radius: 12px; border: 1px solid var(--line2); background: var(--card); padding: 12px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 1.45">
      ${status}
    </div>
    <button type="button" class="btn btn-primary press" disabled=${!ready || busy} style="opacity: ${ready && !busy ? 1 : 0.45}" onClick=${() => app.runImport()}>
      ${x.step === 'importing' ? 'Import en cours…' : 'Importer'}
    </button>`);
}
