// @ts-check
// Explorateur, fiche épisode : vu / non vu, « Tout marquer vu jusqu'ici », épisode précédent / suivant (sans empiler).
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { code, epTitle, fDay } from '../format.js';
import { loadError, navHeader, phLine, providersRow } from '../components.js';
import { untilCounts } from '../store.js';

/** @param {import('../app.js').App} app @param {any} st @param {import('../app.js').View} top */
export function viewEpisode(app, st, top) {
  const id = top.show;
  const n = /** @type {number} */ (top.season);
  const sc = st.seasons[id + ':' + n];
  const name = sc ? sc.data.show.name : top.name || (st.shows[id] && st.shows[id].name) || '';
  const hdr = navHeader(() => app.back(), [
    { label: name, shrink: true, onClick: () => app.crumbTo({ type: 'show', show: id, name }) },
    { label: 'Saison ' + n, onClick: () => app.crumbTo({ type: 'season', show: id, name, season: n }) },
  ], 'E' + top.number);
  const ep = sc ? sc.data.episodes.find((/** @type {any} */ e) => e.id === top.ep) : null;
  if (!ep) {
    const err = st.errs['season:' + id + ':' + n];
    return html`<div class="screen">${hdr}
      <div class="scroll body" style="gap: 14px; padding-top: 20px">
        <span style="font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent)">Saison ${n} · Épisode ${top.number}</span>
        ${sc ? html`<p class="note">Épisode retiré du catalogue</p>` : html`${phLine('80%', 26)}${phLine('50%')}`}
        ${err ? loadError(() => app.loadSeason(id, n)) : null}
      </div>
    </div>`;
  }

  const today = app.today();
  const eps = sc.data.episodes;
  const i = eps.indexOf(ep);
  const w = !!ep.watchedAt;
  const until = untilCounts(sc).get(ep.id) || 0;

  // Voisins : dans la saison, sinon dernier / premier épisode de la saison adjacente (chargée à la demande).
  const seasons = st.shows[id] && st.shows[id].seasons ? st.shows[id].seasons.map((/** @type {any} */ x) => x.number) : null;
  const si = seasons ? seasons.indexOf(n) : -1;
  /** @param {number} dir -1 précédent, +1 suivant */
  const neighbor = (dir) => {
    const inSeason = eps[i + dir];
    if (inSeason) return inSeason;
    if (!seasons || si < 0) return null;
    const m = seasons[si + dir];
    if (m === undefined) return null;
    const other = st.seasons[id + ':' + m];
    if (!other) { app.prefetchSeason(id, m); return null; }
    const list = other.data.episodes;
    return (dir < 0 ? list[list.length - 1] : list[0]) || null;
  };
  const prev = neighbor(-1), next = neighbor(1);
  /** @param {any} e2 */
  const go = (e2) => () => app.replaceTop(app.epView(id, name, e2));
  /** @param {any} e2 @param {string} label */
  const navBtn = (e2, label) => html`<button type="button" disabled=${!e2} onClick=${e2 ? go(e2) : null} style="height: 48px; border-radius: 14px; border: 1px solid var(--cardline); background: var(--card); color: ${e2 ? 'var(--soft)' : 'var(--line-strong)'}; font: 600 13px var(--text); cursor: pointer">${label}</button>`;

  const meta = (ep.airDate ? (ep.aired ? 'Diffusé le ' : 'Diffusion prévue le ') + fDay(ep.airDate, today) : 'Date pas encore annoncée') + (ep.runtime ? ' · ' + ep.runtime + ' min' : '');
  const prov = sc.data.providers;
  return html`
    <div class="screen">
      ${hdr}
      <div class="scroll body" style="gap: 14px; padding-top: 20px">
        <span style="font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent)">Saison ${ep.season} · Épisode ${ep.number}</span>
        <h1 class="h1" style="font-size: 26px; line-height: 1.15; color: ${ep.title ? 'var(--fg)' : 'var(--muted)'}">${epTitle(ep)}${ep.titleIsVo ? ' (VO)' : ''}</h1>
        <span style="font-size: 13px; color: var(--muted)">${meta}</span>
        ${prov.length ? html`<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px">${providersRow(prov)}</div>` : null}
        <span style="font-size: 13px; font-weight: 600; color: ${w ? 'var(--ok)' : 'var(--muted)'}">${w ? 'Vu le ' + fDay(ep.watchedDay, today) : ep.aired ? 'Pas encore vu' : 'Pas encore diffusé'}</span>
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: var(--soft)">${ep.overview || 'Pas de résumé disponible pour cet épisode.'}</p>
        ${ep.aired ? html`<div style="display: flex; flex-direction: column; gap: 10px; margin-top: 6px">
          <button type="button" class=${'btn ' + (w ? 'btn-ghost' : 'btn-primary')} onClick=${() => app.toggleEp(id, ep, w)}>${w ? 'Marquer comme non vu' : 'Marquer comme vu'}</button>
          ${until > 1 ? html`<button type="button" class="btn btn-ghost" style="height: 48px; font-size: 14px; font-weight: 600" onClick=${() => app.markUntil(id, ep, until)}>Tout marquer vu jusqu’ici (${until} épisodes)</button>` : null}
        </div>` : null}
        <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 8px">
          ${navBtn(prev, '‹ ' + (prev ? code(prev.season, prev.number) : '—'))}${navBtn(next, (next ? code(next.season, next.number) : '—') + ' ›')}
        </div>
      </div>
    </div>`;
}
