// @ts-check
// « Mes statistiques », depuis Profil : période et périmètre en haut, totaux, histogramme, records. Tout est calculé par
// le serveur (GET /api/stats) ; une valeur absente s'affiche « Pas assez de données », à la même place.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { cap } from '../format.js';
import { loadError, navHeader, phLine } from '../components.js';

const NONE = 'Pas assez de données';
const CHART_H = 96;
const F_NUM = new Intl.NumberFormat('fr-FR');
const F_MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const F_INITIAL = new Intl.DateTimeFormat('fr-FR', { month: 'narrow', timeZone: 'UTC' });
const F_DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const F_WEEK = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const F_NIGHT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const F_SINCE = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

/** Périodes fixes ; les années disponibles (renvoyées par le serveur) s'ajoutent après. */
const RANGES = [{ v: 'all', l: 'Tout' }, { v: '1y', l: '1 an' }, { v: '6m', l: '6 mois' }, { v: '3m', l: '3 mois' }, { v: '1m', l: '1 mois' }];
const UNIT_TITLES = /** @type {Record<string, string>} */ ({ year: 'Par année', month: 'Par mois', week: 'Par semaine', day: 'Par jour' });

/** 'YYYY-MM' ou 'YYYY-MM-DD' → Date UTC. @param {string} s */
const utc = (s) => new Date(s.length === 7 ? s + '-01T00:00:00Z' : s + 'T00:00:00Z');
const n = (/** @type {number} */ x) => F_NUM.format(x);
/** @param {number} k @param {string} one @param {string} many */
const count = (k, one, many) => n(k) + ' ' + (k > 1 ? many : one);
/** Plus de 2 jours : en jours ; sinon en heures. @param {number} minutes */
const duration = (minutes) => (minutes >= 2 * 1440 ? count(Math.round(minutes / 1440), 'jour', 'jours') : count(Math.round(minutes / 60), 'heure', 'heures'));

/** Libellé complet d'une barre (légende et lecteur d'écran). @param {string} unit @param {string} key */
function barTitle(unit, key) {
  if (unit === 'year') return key;
  if (unit === 'month') return cap(F_MONTH.format(utc(key)));
  return unit === 'week' ? 'Semaine du ' + F_WEEK.format(utc(key)) : cap(F_DAY.format(utc(key)));
}
/** Étiquette courte sous une barre. @param {string} unit @param {string} key */
function barLabel(unit, key) {
  if (unit === 'year') return key.slice(2);
  if (unit === 'month') return F_INITIAL.format(utc(key)).toUpperCase();
  return String(Number(key.slice(8)));
}

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

  // Filtres : période (feuille de choix) et séries non suivies (case).
  const ranges = [...RANGES, ...(d ? d.years : []).map((/** @type {number} */ y) => ({ v: String(y), l: String(y) }))];
  const rangeLabel = (ranges.find((o) => o.v === st.statsRange) || { l: st.statsRange }).l;
  const withUnfollowed = st.statsUnfollowed;
  const filters = html`<section class="group">
    <button type="button" class="row pickrow" onClick=${() => app.setState({ picker: { title: 'Période', value: st.statsRange, list: ranges,
      onPick: (/** @type {string} */ v) => app.setStatsFilter({ statsRange: v }), grid: false } })}>
      <span>Période</span><span class="pickval">${rangeLabel}${I.down()}</span></button>
    <button type="button" role="checkbox" aria-checked=${withUnfollowed ? 'true' : 'false'} class="row pickrow"
      onClick=${() => app.setStatsFilter({ statsUnfollowed: !withUnfollowed })}>
      <span>Inclure les séries non suivies</span>
      <span aria-hidden="true" style="flex: none; width: 44px; display: flex; justify-content: center">
        <span style="width: 22px; height: 22px; box-sizing: border-box; border-radius: 6px; border: 2px solid ${withUnfollowed ? 'var(--accent-solid)' : 'var(--line-strong)'}; background: ${withUnfollowed ? 'var(--accent-solid)' : 'transparent'}; display: flex; align-items: center; justify-content: center">
          ${withUnfollowed ? I.check('var(--on-accent)', 14, 3.5) : null}
        </span>
      </span>
    </button>
  </section>`;

  // Histogramme : une barre par année, mois, semaine ou jour selon la période ; marques seules uniquement.
  const unit = d ? d.histogram.unit : 'year';
  const bars = d ? d.histogram.buckets : [];
  const total = bars.reduce((/** @type {number} */ s, /** @type {any} */ x) => s + x.episodes, 0);
  const max = Math.max(1, ...bars.map((/** @type {any} */ x) => x.episodes));
  const sel = d && st.statsBar != null ? bars[st.statsBar] || null : null;
  const step = bars.length > 13 ? 5 : 1;   // 30 jours : une étiquette sur 5, la dernière (aujourd'hui) comprise
  const caption = !d ? null : !total ? NONE
    : sel ? barTitle(unit, sel.key) + ' : ' + count(sel.episodes, 'épisode', 'épisodes')
    : count(total, 'épisode', 'épisodes') + ' sur la période';
  /** @param {number | null} i */
  const pickBar = (i) => { if (st.statsBar !== i) app.setState({ statsBar: i }); };

  const b = d && d.binge, f = d && d.fastestSeason, c = d && d.closestEnd, u = d && d.catchUp, l = d && d.loyalty;
  return html`
    <div class="screen">
      ${navHeader(() => app.back(), [], 'Mes statistiques', true)}
      <div class="scroll body" style="gap: 22px">
        ${filters}
        ${st.errs.stats && !d ? loadError(() => app.loadStats()) : null}
        <section class="group">
          ${row('Épisodes vus', d ? n(d.episodes) : null)}
          ${row('Temps passé', d ? duration(d.minutes) : null)}
          ${row('Séries commencées', d ? n(d.started) : null)}
          ${row('Séries terminées', d ? n(d.finished) : null)}
        </section>
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 class="eyebrow">${UNIT_TITLES[unit]}</h2>
          <div class="group" style="padding: 14px 12px 10px; gap: 8px">
            <div role="list" aria-label=${'Épisodes vus, ' + UNIT_TITLES[unit].toLowerCase()} onMouseLeave=${() => pickBar(null)}
              style="height: ${CHART_H + 18}px; display: grid; grid-template-columns: repeat(${bars.length || 12}, minmax(0, 1fr)); gap: 2px; border-bottom: 1px solid var(--cardline)">
              ${bars.map((/** @type {any} */ x, /** @type {number} */ i) => html`<button type="button" role="listitem"
                aria-label=${barTitle(unit, x.key) + ' : ' + count(x.episodes, 'épisode', 'épisodes')}
                onClick=${() => pickBar(st.statsBar === i ? null : i)} onMouseEnter=${() => pickBar(i)}
                style="height: 100%; min-width: 0; padding: 0; border: 0; background: transparent; cursor: pointer; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px">
                <span aria-hidden="true" style="width: min(14px, 100%); height: ${x.episodes ? Math.max(3, Math.round((x.episodes / max) * CHART_H)) : 0}px; border-radius: 4px 4px 0 0; background: var(--accent); opacity: ${sel && sel !== x ? 0.45 : 1}"></span>
                <span aria-hidden="true" style="height: 14px; font-size: 11px; line-height: 14px; white-space: nowrap; color: ${sel === x ? 'var(--fg)' : 'var(--muted)'}">${(bars.length - 1 - i) % step === 0 ? barLabel(unit, x.key) : ''}</span>
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
