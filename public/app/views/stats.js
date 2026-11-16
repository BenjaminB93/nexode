// @ts-check
// « Mes statistiques », depuis Profil : totaux, visionnages des 12 derniers mois, records. Tout est calculé par le serveur
// (GET /api/stats) ; une valeur absente s'affiche « Pas assez de données », à la même place.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { cap } from '../format.js';
import { loadError, navHeader, phLine } from '../components.js';

const NONE = 'Pas assez de données';
const CHART_H = 96;
const F_NUM = new Intl.NumberFormat('fr-FR');
const F_MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const F_INITIAL = new Intl.DateTimeFormat('fr-FR', { month: 'narrow', timeZone: 'UTC' });
const F_NIGHT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const F_SINCE = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

/** 'YYYY-MM' ou 'YYYY-MM-DD' → Date UTC. @param {string} s */
const utc = (s) => new Date(s.length === 7 ? s + '-01T00:00:00Z' : s + 'T00:00:00Z');
const n = (/** @type {number} */ x) => F_NUM.format(x);
/** @param {number} k @param {string} one @param {string} many */
const count = (k, one, many) => n(k) + ' ' + (k > 1 ? many : one);
/** Plus de 2 jours : en jours ; sinon en heures. @param {number} minutes */
const duration = (minutes) => (minutes >= 2 * 1440 ? count(Math.round(minutes / 1440), 'jour', 'jours') : count(Math.round(minutes / 60), 'heure', 'heures'));

/** @param {import('../app.js').App} app @param {any} st */
export function viewStats(app, st) {
  const d = st.stats;
  const muted = 'font-size: 14px; color: var(--muted)';
  /** Ligne libellé / valeur ; valeur null = en chargement. @param {string} label @param {string | null} value */
  const row = (label, value) => html`<div class="row" style="padding-right: 16px"><span>${label}</span>
    <span style=${muted}>${value === null ? phLine(60, 12) : value}</span></div>`;

  /**
   * Record : libellé, valeur et détail ; null = pas assez de données ; show = ouvre la fiche série.
   * @param {string} label @param {{ value: string, detail: string, show?: any } | null} r
   */
  const record = (label, r) => {
    const body = html`<span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 10px 0">
      <span style="font-size: 12px; color: var(--muted)">${label}</span>
      ${!d ? html`<span style="height: 20px; display: flex; align-items: center">${phLine(160, 14)}</span>`
        : html`<span class="ell" style=${r ? 'font-size: 15px; line-height: 20px; font-weight: 600' : 'font-size: 15px; line-height: 20px; color: var(--muted)'}>${r ? r.value : NONE}</span>`}
      <span class="ell" style="font-size: 13px; line-height: 18px; color: var(--muted)">${d && r ? r.detail : ' '}</span>
    </span>`;
    return r && r.show
      ? html`<button type="button" class="row pickrow" style="text-align: left" onClick=${() => app.openShow(r.show)}>${body}<span style="color: var(--muted)">${I.chev()}</span></button>`
      : html`<div class="row" style="padding-right: 16px">${body}</div>`;
  };

  const months = d ? d.months : [];
  const total = months.reduce((/** @type {number} */ s, /** @type {any} */ m) => s + m.episodes, 0);
  const max = Math.max(1, ...months.map((/** @type {any} */ m) => m.episodes));
  const sel = d && st.statsMonth != null ? months[st.statsMonth] : null;
  const caption = !d ? null : !total ? NONE
    : sel ? cap(F_MONTH.format(utc(sel.month))) + ' : ' + count(sel.episodes, 'épisode', 'épisodes')
    : count(total, 'épisode', 'épisodes') + ' en 12 mois';
  /** @param {number | null} i */
  const pickMonth = (i) => { if (st.statsMonth !== i) app.setState({ statsMonth: i }); };

  const b = d && d.binge, f = d && d.fastestSeason, c = d && d.closestEnd, u = d && d.catchUp, l = d && d.loyalty;
  return html`
    <div class="screen">
      ${navHeader(() => app.back(), [], 'Mes statistiques', true)}
      <div class="scroll body" style="gap: 22px">
        ${st.errs.stats && !d ? loadError(() => app.loadStats()) : null}
        <section class="group">
          ${row('Épisodes vus', d ? n(d.episodes) : null)}
          ${row('Temps passé', d ? duration(d.minutes) : null)}
          ${row('Séries commencées', d ? n(d.started) : null)}
          ${row('Séries terminées', d ? n(d.finished) : null)}
        </section>
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 class="eyebrow">12 derniers mois</h2>
          <div class="group" style="padding: 14px 12px 10px; gap: 8px">
            <div role="list" aria-label="Épisodes vus par mois" onMouseLeave=${() => pickMonth(null)}
              style="height: ${CHART_H + 18}px; display: grid; grid-template-columns: repeat(${months.length || 12}, minmax(0, 1fr)); gap: 2px; border-bottom: 1px solid var(--cardline)">
              ${months.map((/** @type {any} */ m, /** @type {number} */ i) => html`<button type="button" role="listitem"
                aria-label=${cap(F_MONTH.format(utc(m.month))) + ' : ' + count(m.episodes, 'épisode', 'épisodes')}
                onClick=${() => pickMonth(st.statsMonth === i ? null : i)} onMouseEnter=${() => pickMonth(i)}
                style="height: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px">
                <span aria-hidden="true" style="width: min(14px, 100%); height: ${m.episodes ? Math.max(3, Math.round((m.episodes / max) * CHART_H)) : 0}px; border-radius: 4px 4px 0 0; background: var(--accent); opacity: ${sel && sel !== m ? 0.45 : 1}"></span>
                <span aria-hidden="true" style="font-size: 11px; line-height: 14px; color: ${sel === m ? 'var(--fg)' : 'var(--muted)'}">${F_INITIAL.format(utc(m.month)).toUpperCase()}</span>
              </button>`)}
            </div>
            <span style="min-height: 18px; font-size: 13px; line-height: 18px; color: var(--muted)">${caption === null ? phLine(120, 12) : caption}</span>
          </div>
        </section>
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 class="eyebrow">Records</h2>
          <section class="group">
            ${record('Plus gros binge', b && { value: count(b.episodes, 'épisode', 'épisodes') + ' de ' + b.show.name, detail: 'Nuit du ' + F_NIGHT.format(utc(b.night)), show: b.show })}
            ${record('Saison dévorée le plus vite', f && { value: f.show.name + ', saison ' + f.season, detail: count(f.episodes, 'épisode', 'épisodes') + ' en ' + count(f.days, 'jour', 'jours'), show: f.show })}
            ${record('Abandon le plus rageant', c && { value: c.show.name, detail: c.remaining > 1 ? 'Plus que ' + n(c.remaining) + ' épisodes' : 'Plus qu’un épisode', show: c.show })}
            ${record('Dès la sortie', d && d.sameDay !== null ? { value: count(d.sameDay, 'épisode', 'épisodes'), detail: 'Vus le jour de leur sortie ou le lendemain' } : null)}
            ${record('Record de rattrapage', u && { value: count(u.episodes, 'épisode', 'épisodes') + ' de ' + u.show.name, detail: 'Marqués vus le ' + F_NIGHT.format(utc(u.night)), show: u.show })}
            ${record('Plus longue fidélité', l && { value: l.show.name, detail: 'Regardée depuis ' + F_SINCE.format(new Date(l.since)), show: l.show })}
          </section>
        </section>
      </div>
    </div>`;
}
