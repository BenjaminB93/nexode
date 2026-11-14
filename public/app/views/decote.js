// @ts-check
// Onglet « De côté » : pas commencées + abandonnées. Tap = fiche série, swipe = prochain épisode vu.
// Une série swipée reste à sa place (« Repasse dans « En cours » ») jusqu'au prochain passage sur l'onglet.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { ago, code, epTitle, localDay, plural } from '../format.js';
import { header, loadError, poster, swipeShell } from '../components.js';

/** @param {import('../app.js').App} app @param {any} st */
export function viewDecote(app, st) {
  const sh = st.shelf;
  if (!sh) {
    return html`<div class="screen">${header('De côté')}<div class="scroll body">${st.errs.shelf ? loadError(() => app.loadShelf()) : null}</div></div>`;
  }
  const today = app.today();
  const tz = app.tz();
  /** @param {number[]} ids */
  const visible = (ids) => ids.map((id) => sh.cards[id]).filter((c) => c && c.relation !== 'none');
  const notStarted = visible(sh.notStarted);
  const abandoned = visible(sh.abandoned);

  /** @param {any} c */
  const card = (c) => {
    const show = c.show;
    const nx = c.next;
    const reason = c.back ? 'Repasse dans « En cours »'
      : c.reason.kind === 'manual' ? 'Mise de côté à la main'
      : c.reason.kind === 'added' ? 'Ajoutée ' + ago(localDay(c.reason.at, tz), today)
      : 'Dernier épisode vu ' + ago(c.reason.day, today);
    const sw = app.swipe('d:' + show.id, !!nx, () => { if (nx) app.markEp(show.id, nx, show.name + ' ' + code(nx.season, nx.number) + ' vu'); });
    const inner = html`
      ${poster(show.posterPath, 52, 78, 8, 'opacity: 0.85')}
      <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px">
        <span class="ell" style="font-size: 15px; font-weight: 600">${show.name}</span>
        <span class="ell" style="font-size: 12px; color: ${c.back ? 'var(--ok)' : 'var(--muted)'}">${reason}</span>
        <span class="ell" style="font-size: 12px; color: var(--soft)">${nx
          ? html`Prochain : <span style="color: var(--accent)">${code(nx.season, nx.number)}</span> ${epTitle(nx)}`
          : c.remaining ? 'Prochain : …' : 'À jour'}</span>
      </span>
      <span class="badge" style="background: var(--chip); color: var(--soft)">${c.remaining}</span>`;
    return html`<div key=${show.id}>${swipeShell(sw, 96, 16, 'Vu', inner, app.tap(() => app.openShow(show)), 'background: var(--card); border: 1px solid var(--cardline); padding: 8px 14px 8px 8px')}</div>`;
  };
  /** @param {string} title @param {any[]} list */
  const sec = (title, list) => (list.length
    ? html`<section style="display: flex; flex-direction: column; gap: 10px"><h2 class="eyebrow">${title} · ${list.length}</h2>${list.map(card)}</section>`
    : null);
  return html`
    <div class="screen">
      ${header('De côté', plural(notStarted.length + abandoned.length, 'série', 'séries'))}
      <div class="scroll body" style="gap: 22px">${sec('Pas commencées', notStarted)}${sec('Abandonnées', abandoned)}</div>
    </div>`;
}
