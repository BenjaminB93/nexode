// @ts-check
// Explorateur, saison : épisodes avec coche (= swipe, dans les deux sens), coche de toute la saison.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { code, epTitle, fDay, fShort, fTime, plural } from '../format.js';
import { dot, dotView, loadError, navHeader, phLine } from '../components.js';

/** @param {import('../app.js').App} app @param {any} st @param {import('../app.js').View} top */
export function viewSeason(app, st, top) {
  const id = top.show;
  const n = /** @type {number} */ (top.season);
  const sc = st.seasons[id + ':' + n];
  const name = sc ? sc.data.show.name : top.name || (st.shows[id] && st.shows[id].name) || '';
  const hdr = navHeader(() => app.back(), [{ label: name, shrink: true, onClick: () => app.crumbTo({ type: 'show', show: id, name }) }], 'Saison ' + n);
  if (!sc) {
    return html`<div class="screen">${hdr}
      <div class="scroll body" style="gap: 14px">
        <div style="display: flex; flex-direction: column; gap: 3px"><h1 class="h1">Saison ${n}</h1><span style="display: flex; height: 17px; align-items: center">${phLine(90)}</span></div>
        ${st.errs['season:' + id + ':' + n] ? loadError(() => app.loadSeason(id, n))
          : html`<div style="display: flex; flex-direction: column; gap: 6px">${[0, 1, 2, 3].map((i) => html`<div key=${i} aria-hidden="true" style="height: 62px; box-sizing: border-box; border-radius: 12px; border: 1px solid var(--line); background: var(--hist-bg)"></div>`)}</div>`}
      </div>
    </div>`;
  }

  const today = app.today();
  const eps = sc.data.episodes;
  const aired = eps.filter((/** @type {any} */ e) => e.aired).length;
  const seen = eps.filter((/** @type {any} */ e) => e.watchedAt).length;
  const complete = aired > 0 && !eps.some((/** @type {any} */ e) => e.aired && !e.watchedAt);
  const dsea = dot(complete, aired > 0);
  return html`
    <div class="screen">
      ${hdr}
      <div class="scroll body" style="gap: 14px">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
          <div style="display: flex; flex-direction: column; gap: 3px">
            <h1 class="h1">Saison ${n}</h1>
            <span style="font-size: 13px; color: var(--muted)">${seen}/${eps.length} vus${aired < eps.length ? ' · ' + plural(eps.length - aired, 'épisode à venir', 'épisodes à venir') : ''}</span>
          </div>
          <button type="button" disabled=${!aired} onClick=${() => app.askSeason(id, n)} style="flex: none; height: 44px; padding: 0 12px 0 8px; border-radius: 22px; border: 1px solid var(--line2); background: transparent; color: var(--fg); font: 600 13px var(--text); display: flex; align-items: center; gap: 8px; cursor: pointer">${dotView(dsea)}${complete ? 'Saison vue' : 'Toute la saison'}</button>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px">
          ${eps.map((/** @type {any} */ ep) => {
            const w = !!ep.watchedAt;
            const sub = !ep.airDate ? 'date inconnue'
              : ep.aired ? (w ? 'vu le ' + fShort(ep.watchedDay, today) + ' à ' + fTime(ep.watchedAt, app.tz()) : ep.airDate === today ? 'sorti aujourd’hui' : 'sorti le ' + fShort(ep.airDate, today))
              : 'à venir · ' + fDay(ep.airDate, today);
            const sw = app.swipe('e:' + ep.id, ep.aired, () => app.toggleEp(id, ep, w));
            const label = w ? 'Non vu' : 'Vu';
            return html`<div key=${ep.id} style="position: relative; height: 62px; border-radius: 12px; overflow: hidden; background: ${sw.bg}">
              <div class="reveal" aria-hidden="true" style="padding: 0 18px; font-size: 12px; color: ${sw.fg}; opacity: ${sw.op}"><span>${label}</span><span>${label}</span></div>
              <div class="sw" onPointerDown=${sw.down} onPointerMove=${sw.move} onPointerUp=${sw.up} onPointerCancel=${sw.cancel}
                style="position: absolute; inset: 0; box-sizing: border-box; border-radius: 12px; border: 1px solid var(--line); background: var(--hist-bg); display: flex; align-items: center; touch-action: pan-y; transform: translateX(${sw.dx}px); transition: ${sw.tr}">
                <button type="button" onClick=${app.tap(() => app.openEp({ id, name }, ep))} style="flex: 1; min-width: 0; height: 60px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; display: flex; align-items: center; gap: 12px; padding: 0 4px 0 14px; cursor: pointer">
                  <span style="flex: none; width: 34px; font-size: 13px; font-weight: 700; color: ${ep.aired ? 'var(--accent)' : 'var(--faint)'}">E${ep.number}</span>
                  <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px">
                    <span class="ell" style="font-size: 14px; font-weight: 500; color: ${ep.aired ? 'var(--fg)' : 'var(--faint)'}">${epTitle(ep)}${ep.titleIsVo ? ' (VO)' : ''}</span>
                    <span style="font-size: 12px; color: var(--faint)">${sub}</span>
                  </span>
                </button>
                ${ep.aired
                  ? html`<button type="button" aria-label=${(w ? 'Marquer non vu ' : 'Marquer vu ') + code(ep.season, ep.number)} onClick=${app.tap(() => app.toggleEp(id, ep, w))} style="flex: none; width: 52px; height: 60px; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer">${dotView(dot(w, true))}</button>`
                  : html`<span style="flex: none; width: 52px; display: flex; align-items: center; justify-content: center"><span class="dot" style="border: 2px dashed var(--line2)"></span></span>`}
              </div>
            </div>`;
          })}
        </div>
      </div>
    </div>`;
}
