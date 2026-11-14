// @ts-check
// Onglet « En cours » : timeline verticale. Historique (défile vers le haut), « Maintenant · à regarder », puis « À venir »
// derrière un ressort (pas dans la page tant qu'il est fermé).
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { cap, code, dayLabel, epTitle, fDay, fShort, inDays } from '../format.js';
import { header, loadError, phLine, poster, swipeShell } from '../components.js';

/** @param {import('../app.js').App} app @param {any} st */
export function viewEncours(app, st) {
  const today = app.today();
  const tl = st.tl;
  if (!tl) {
    return html`<div class="screen">
      ${header('En cours')}
      <div class="scroll body">${st.errs.tl ? loadError(() => app.loadTimeline()) : null}</div>
    </div>`;
  }

  // Historique : le plus ancien en haut, groupé par jour de visionnage.
  const items = st.hist ? st.hist.items.slice().reverse() : [];
  /** @type {{ d: string, label: string, items: any[] }[]} */
  const groups = [];
  for (const it of items) {
    let g = groups[groups.length - 1];
    if (!g || g.d !== it.watchedDay) {
      g = { d: it.watchedDay, label: dayLabel(it.watchedDay, today), items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }

  // À venir : groupé par date de sortie.
  /** @type {{ d: string, label: string, rel: string, items: any[] }[]} */
  const ug = [];
  for (const u of tl.upcoming) {
    let g = ug[ug.length - 1];
    if (!g || g.d !== u.episode.airDate) {
      g = { d: u.episode.airDate, label: cap(fDay(u.episode.airDate, today)), rel: inDays(u.episode.airDate, today), items: [] };
      ug.push(g);
    }
    g.items.push(u);
  }
  /** @param {any} u @param {boolean} interactive */
  const upItem = (u, interactive) => {
    const ep = u.episode;
    const inner = html`
      ${poster(u.show.posterPath, 37, 56, 6)}
      <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
        <span class="show-name ell">${u.show.name}</span>
        <span class="ell" style="font-size: 14px; font-weight: 600"><span style="color: var(--accent)">${code(ep.season, ep.number)}</span> <span style="color: ${ep.title ? 'var(--fg)' : 'var(--muted)'}">${epTitle(ep)}</span></span>
      </span>
      ${u.more ? html`<span class="badge" style="background: var(--accent-bg); color: var(--accent)">+${u.more}</span>` : null}`;
    const style = 'height: 72px; box-sizing: border-box; border-radius: 14px; border: 1px solid var(--cardline); background: transparent; display: flex; align-items: center; gap: 12px; padding: 8px 14px 8px 8px; text-align: left; color: inherit; font: inherit';
    return interactive
      ? html`<button type="button" key=${ep.id} onClick=${app.tap(() => app.openEp(u.show, ep))} style="${style}; cursor: pointer">${inner}</button>`
      : html`<div key=${ep.id} style=${style}>${inner}</div>`;
  };
  /** @param {{ d: string, label: string, rel: string, items: any[] }} g @param {boolean} interactive */
  const upGroup = (g, interactive) => html`
    <div key=${g.d} style="display: flex; flex-direction: column; gap: 8px">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px">
        <span class="eyebrow">${g.label}</span><span style="font-size: 12px; color: var(--muted)">${g.rel}</span>
      </div>
      ${(interactive ? g.items : g.items.slice(0, 2)).map((u) => upItem(u, interactive))}
    </div>`;

  // À regarder : ordre figé à l'entrée dans l'onglet ; une série vue jusqu'au bout reste à sa place (« À jour »).
  const toWatch = tl.order.map((/** @type {number} */ id) => tl.entries[id]).filter((/** @type {any} */ e) => e && e.relation !== 'none').map((/** @type {any} */ e) => {
    const show = e.show;
    const nx = e.next;
    if (!nx && !e.remaining) {
      const fut = tl.upcoming.find((/** @type {any} */ u) => u.show.id === show.id);
      const note = fut ? 'Prochain : ' + code(fut.episode.season, fut.episode.number) + ', ' + fDay(fut.episode.airDate, today)
        : e.status === 'terminee' ? 'Série terminée, tout est vu' : 'Prochain épisode pas encore annoncé';
      return html`<div key=${show.id} style="height: 88px"><button type="button" onClick=${app.tap(() => app.openShow(show))} style="width: 100%; height: 88px; box-sizing: border-box; border-radius: 16px; background: transparent; border: 1px dashed var(--line2); display: flex; align-items: center; gap: 12px; padding: 8px 14px 8px 8px; text-align: left; color: inherit; font: inherit; cursor: pointer">
        ${poster(show.posterPath, 48, 72, 8, 'opacity: 0.4')}
        <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
          <span class="show-name ell">${show.name}</span>
          <span style="font-size: 14px; font-weight: 600; color: var(--ok-fg)">À jour</span>
          <span class="ell" style="font-size: 12px; color: var(--muted)">${note}</span>
        </span></button></div>`;
    }
    // nx absent avec des épisodes restants : le suivant arrive du serveur, la carte garde sa place.
    const sw = app.swipe('c:' + show.id, !!nx, () => { if (nx) app.markEp(show.id, nx, show.name + ' ' + code(nx.season, nx.number) + ' vu'); });
    const inner = html`
      ${poster(show.posterPath, 48, 72, 8)}
      <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
        <span class="show-name ell">${show.name}</span>
        ${nx
          ? html`<span class="ell" style="font-size: 15px; font-weight: 600"><span style="color: var(--accent)">${code(nx.season, nx.number)}</span> ${epTitle(nx)}</span>
            <span style="display: flex; align-items: center; gap: 6px; height: 16px; font-size: 12px; color: var(--muted)">${!nx.airDate ? '' : nx.airDate === today ? 'sorti aujourd’hui' : 'sorti le ' + fShort(nx.airDate, today)}${nx.titleIsVo ? html`<span class="vo">VO</span>` : null}</span>`
          : html`<span style="display: flex; flex-direction: column; gap: 7px; padding: 3px 0">${phLine('70%', 14)}${phLine('40%')}</span>`}
      </span>
      ${e.remaining > 1 ? html`<span class="badge" style="background: var(--accent-bg); color: var(--accent)">+${e.remaining - 1}</span>` : null}`;
    return html`<div key=${show.id} style="height: 88px">${swipeShell(sw, 88, 16, I.check(null, 22), inner, app.tap(() => { if (nx) app.openEp(show, nx); else app.openShow(show); }), 'background: var(--card); border: 1px solid var(--cardline); padding: 8px 14px 8px 8px')}</div>`;
  });

  return html`
    <div class="screen">
      ${header('En cours', fDay(today, today))}
      <div class="scroll" ref=${app.setScroller} onScroll=${app.onScroll} onTouchStart=${app.onTouchStart} onTouchMove=${app.onTouchMove} onTouchEnd=${app.onTouchEnd} onTouchCancel=${app.onTouchEnd} onWheel=${app.onWheel}
        style="position: absolute; left: 0; right: 0; top: 64px; bottom: 0; overflow-y: auto; overflow-anchor: none; overscroll-behavior: contain; padding: 0 16px">
        <div ref=${app.setContent}>
          <section aria-label="Historique" style="display: flex; flex-direction: column; gap: 14px; padding-top: 28px">
            ${groups.map((g) => html`
              <div key=${g.d} style="display: flex; flex-direction: column; gap: 4px">
                <span class="daylabel">${g.label}</span>
                ${g.items.map((it) => {
                  const ep = { id: it.episodeId, season: it.season, number: it.number, title: it.title, titleIsVo: it.titleIsVo };
                  const sw = app.swipe('h:' + it.episodeId, true, () => app.unmarkEp(it.show.id, ep, it.show.name + ' ' + code(it.season, it.number) + ' remis en non vu'));
                  const inner = html`
                    ${poster(it.show.posterPath, 30, 45, 5, 'opacity: 0.45; filter: grayscale(0.6)')}
                    <span class="ell" style="flex: 1; min-width: 0; font-size: 13px; color: var(--hist)">${it.show.name} · <span style="color: var(--hist-strong)">${code(it.season, it.number)}</span> ${epTitle(it)}</span>
                    ${I.check('var(--hist-check)', 16, 2.5)}`;
                  return html`<div key=${it.episodeId}>${swipeShell(sw, 50, 10, 'Non vu', inner, app.tap(() => app.openEp(it.show, ep)), 'border: 0; background: var(--bg); padding: 0 4px; gap: 10px')}</div>`;
                })}
              </div>`)}
          </section>
          <div data-anchor="regarder" style="display: flex; flex-direction: column">
            <div role="separator" aria-label="Maintenant" style="display: flex; align-items: center; gap: 10px; margin: 18px 0 12px">
              <span style="flex: 1; height: 1px; background: var(--accent); opacity: 0.6"></span>
              <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent)">Maintenant · à regarder</span>
              <span style="flex: 1; height: 1px; background: var(--accent); opacity: 0.6"></span>
            </div>
            <section aria-label="À regarder" style="display: flex; flex-direction: column; gap: 10px">${toWatch}</section>
            <div aria-hidden="true" style="margin: 18px 0 20px; display: flex; justify-content: center">
              <span ref=${app.setHandle} style="width: 36px; height: 4px; border-radius: 2px; background: var(--line2)"></span>
            </div>
          </div>
          ${st.upcomingOpen ? html`
            <section aria-label="À venir" style="min-height: 520px; box-sizing: border-box; padding: 16px 0 32px; display: flex; flex-direction: column; gap: 18px">
              <h2 style="margin: 0; font-family: var(--display); font-size: 18px; font-weight: 700">À venir</h2>
              ${ug.map((g) => upGroup(g, true))}
            </section>` : null}
        </div>
      </div>
      ${!st.upcomingOpen && ug.length ? html`
        <div aria-hidden="true" ref=${app.setPeek} style="position: absolute; left: 0; right: 0; bottom: 0; height: 260px; overflow: hidden; pointer-events: none; opacity: 0">
          <div ref=${app.setPeekInner} style="padding: 16px 16px 0; display: flex; flex-direction: column; gap: 18px; transform: translateY(260px)">
            <h2 style="margin: 0; font-family: var(--display); font-size: 18px; font-weight: 700">À venir</h2>
            ${upGroup(ug[0], false)}
          </div>
        </div>` : null}
    </div>`;
}
