// @ts-check
// Explorateur, fiche série : sélecteur de suivi, où regarder, résumé, saisons (coche de saison avec confirmation).
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { CHIPS, countryName, plural, showMeta, tmdbUrl, tmdbWatchUrl } from '../format.js';
import { dot, dotView, extLink, loadError, navHeader, phLine, poster, providersRow, segmented } from '../components.js';

/** @param {import('../app.js').App} app @param {any} st @param {import('../app.js').View} top */
export function viewShow(app, st, top) {
  const id = top.show;
  const d = st.shows[id];
  const name = d ? d.name : top.name || '';
  const hdr = navHeader(() => app.back(), [], name, true);
  if (!d) {
    return html`<div class="screen">${hdr}
      <div class="scroll body">
        <div style="display: flex; gap: 14px">
          ${poster(null, 92, 138, 10)}
          <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; justify-content: center">
            ${name ? html`<h1 class="h1" style="line-height: 1.15">${name}</h1>` : phLine('70%', 22)}
            ${phLine('60%')}
            <span aria-hidden="true" style="display: block; max-width: 280px; height: 36px; margin-top: 4px; border-radius: 10px; border: 1px solid var(--cardline); box-sizing: border-box"></span>
          </div>
        </div>
        ${st.errs['show:' + id] ? loadError(() => app.loadShow(id)) : null}
      </div>
    </div>`;
  }

  // Position du milieu : l'état que la série a, ou aurait, en étant suivie hors mise de côté (ne change pas au tap).
  const mid = CHIPS[d.wouldBeStatus] || CHIPS.encours;
  const segs = [
    { v: 'none', l: 'Non suivie', c: ['var(--chip)', 'var(--soft)'] },
    { v: 'on', l: mid[0], c: [mid[1], mid[2]] },
    { v: 'shelf', l: 'De côté', c: [CHIPS.decote[1], CHIPS.decote[2]] },
  ];
  const relationBar = segmented('Suivi de la série', segs, d.relation, (v) => app.setRelation(id, /** @type {'none' | 'on' | 'shelf'} */ (v)), 'align-self: stretch; max-width: 280px; margin-top: 4px');
  const groups = d.providers.groups;
  return html`
    <div class="screen">
      ${hdr}
      <div class="scroll body">
        <div style="display: flex; gap: 14px">
          ${poster(d.posterPath, 92, 138, 10)}
          <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; justify-content: center">
            <h1 class="h1" style="line-height: 1.15">${d.name}</h1>
            <span style="font-size: 13px; color: var(--muted)">${showMeta(d)}</span>
            ${relationBar}
          </div>
        </div>
        <section aria-label="Où regarder" style="display: flex; flex-direction: column; gap: 8px">
          <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint)">Où regarder · ${countryName(d.providers.country)}</span>
          ${groups.map((/** @type {any} */ g) => html`<div key=${g.from} style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px">${g.label ? html`<span style="flex: none; min-width: 76px; font-size: 12px; color: var(--faint)">${g.label}</span>` : null}${providersRow(g.items)}</div>`)}
          ${groups.length ? null : html`<span style="font-size: 13px; color: var(--faint)">Aucune plateforme d’abonnement connue</span>`}
          ${extLink(tmdbWatchUrl(id, d.providers.country), 'Données JustWatch')}
        </section>
        <p style="margin: 0; font-size: 14px; line-height: 1.55; color: var(--soft)">${d.overview || 'Pas de résumé disponible.'}</p>
        <h2 class="eyebrow" style="margin-top: 6px">Saisons</h2>
        <div style="display: flex; flex-direction: column; gap: 8px">
          ${d.seasons.map((/** @type {any} */ se) => {
            const n = se.number;
            const complete = se.aired > 0 && se.seen >= se.aired;
            const first = se.firstAirDate ? se.firstAirDate.slice(0, 4) : 'date à venir';
            return html`<div key=${n} class="card" style="height: 64px; box-sizing: border-box; border-radius: 14px; display: flex; align-items: center; padding: 0 6px 0 0">
              <button type="button" onClick=${() => app.openSeason(id, n, d.name)} style="flex: 1; min-width: 0; height: 62px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; display: flex; align-items: center; gap: 12px; padding: 0 8px 0 16px; cursor: pointer">
                <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
                  <span style="font-size: 15px; font-weight: 600">Saison ${n}</span>
                  <span style="font-size: 12px; color: var(--muted)">${plural(se.count, 'épisode', 'épisodes')} · ${first}</span>
                </span>
                <span style="flex: none; font-size: 12px; font-weight: 600; color: ${complete ? 'var(--ok)' : 'var(--muted)'}">${se.seen}/${se.count}</span>
                ${I.chev()}
              </button>
              <button type="button" class="iconbtn" aria-label=${complete ? 'Marquer la saison ' + n + ' non vue' : 'Marquer toute la saison ' + n + ' vue'} disabled=${!se.aired} onClick=${() => app.askSeason(id, n)}>${dotView(dot(complete, se.aired > 0))}</button>
            </div>`;
          })}
        </div>
        ${extLink(tmdbUrl(id), 'Fiche TMDB')}
      </div>
    </div>`;
}
