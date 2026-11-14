// @ts-check
// Comptes, depuis Profil : Parrainages (mes liens d'invitation), Comptes (admin), et leurs feuilles
// (lien à partager, compte, export des données, suppression de mon compte).
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { ROLE_SEGS, dayOf, fShort, inDays, plural } from '../format.js';
import { inviteGroups } from '../auth.js';
import {
  DANGER_BTN, avatar, formError, listRow, listRowPlaceholder, loadError, navHeader, passwordField, phLine, roleChip, segmented, sheet,
} from '../components.js';

/** Dates des comptes et liens : jour local de l'utilisateur. @param {import('../app.js').App} app */
function dates(app) {
  const tz = app.tz(), today = app.today();
  return {
    today,
    /** @param {string} x */
    day: (x) => dayOf(x, tz),
    /** « 13 nov. » @param {string} x */
    short: (x) => fShort(dayOf(x, tz), today),
  };
}

const linkIcon = (/** @type {boolean} */ live) => html`<span aria-hidden="true" style="flex: none; width: 40px; height: 40px; border-radius: 20px; background: ${live ? 'var(--accent-bg)' : 'var(--chip)'}; color: ${live ? 'var(--accent)' : 'var(--faint)'}; display: flex; align-items: center; justify-content: center">${I.link()}</span>`;

/** « Invité par X · » / « Invité par un compte supprimé · », ou '' pour un compte créé sans lien. @param {any} u */
const invitedBy = (u) => (u.invitedByDeleted ? 'Invité par un compte supprimé · ' : u.invitedBy ? 'Invité par ' + u.invitedBy + ' · ' : '');

/** Parrainages : les liens que j'ai créés et qui les a utilisés. @param {import('../app.js').App} app @param {any} st */
export function viewInvites(app, st) {
  const d = dates(app);
  const list = st.invites;
  /** @param {string} title @param {any[]} items @param {(x: any) => any} row */
  const sec = (title, items, row) => (items.length
    ? html`<section style="display: flex; flex-direction: column; gap: 2px"><h2 class="eyebrow" style="margin-bottom: 6px">${title} · ${items.length}</h2>${items.map(row)}</section>`
    : null);
  /** Rôle d'un filleul : connu seulement de l'admin (liste des comptes chargée). @param {string} name */
  const roleOf = (name) => {
    const u = st.users ? st.users.find((/** @type {any} */ x) => x.username === name) : null;
    return u ? roleChip(u.role) : null;
  };
  /** @param {any} x */
  const joined = (x) => (x.usedAt ? 'A rejoint le ' + d.short(x.usedAt) + ' · ' : '') + 'lien du ' + d.short(x.createdAt);
  let content;
  if (!list) content = st.errs.invites ? loadError(() => app.loadInvites()) : html`<div style="display: flex; flex-direction: column; gap: 2px">${listRowPlaceholder()}${listRowPlaceholder()}</div>`;
  else {
    const g = inviteGroups(list);
    content = html`
      ${sec('En attente', g.pending, (x) => listRow(linkIcon(true), 'Lien du ' + d.short(x.createdAt), 'Expire ' + inDays(d.day(x.expiresAt), d.today), I.chev(), () => app.openInvite(x)))}
      ${sec('Ont rejoint', g.used, (x) => (x.usedByDeleted || !x.usedBy
        ? listRow(avatar('?'), 'Compte supprimé', joined(x), null, null, true)
        : listRow(avatar(x.usedBy), x.usedBy, joined(x), roleOf(x.usedBy), null)))}
      ${sec('Expirés ou révoqués', g.dead, (x) => listRow(linkIcon(false), 'Lien du ' + d.short(x.createdAt),
        x.status === 'revoked' ? 'Révoqué' : 'Expiré le ' + d.short(x.expiresAt), null, null, true))}`;
  }
  return html`
    <div class="screen">
      ${navHeader(() => app.back(), [], 'Parrainages', true)}
      <div class="scroll body" style="gap: 22px">
        <button type="button" class="btn btn-primary press" style="flex: none" disabled=${st.creatingInvite} onClick=${() => app.createInvite()}>Créer un lien d’invitation</button>
        ${content}
      </div>
    </div>`;
}

/** Administration : tous les comptes, rôle et lien de réinitialisation. @param {import('../app.js').App} app @param {any} st */
export function viewAdmin(app, st) {
  const d = dates(app);
  const users = st.users;
  let content;
  if (!users) content = st.errs.users ? loadError(() => app.loadUsers()) : html`${listRowPlaceholder()}${listRowPlaceholder()}${listRowPlaceholder()}`;
  else {
    content = users.map((/** @type {any} */ u) => {
      const sub = (invitedBy(u) || 'Créé le ') + d.short(u.createdAt);
      const admin = u.role === 'admin';
      return listRow(avatar(u.username), u.username, sub, html`${roleChip(u.role)}${admin ? null : I.chev()}`, admin ? null : () => app.setState({ account: u.id }));
    });
  }
  return html`
    <div class="screen">
      ${navHeader(() => app.back(), [], 'Comptes', true)}
      <div class="scroll body" style="gap: 2px">${content}</div>
    </div>`;
}

/**
 * Lien d'invitation ou de réinitialisation : partager, copier. url absente = lien en attente rouvert plus tard
 * (le serveur n'en garde que l'empreinte) : seulement ses infos et la révocation.
 * @param {import('../app.js').App} app @param {{ title: string, sub: string, url: string | null, inviteId?: number, copied?: 'ok' | 'fail' | null }} l
 */
export function linkSheetView(app, l) {
  const copyLabel = l.copied === 'ok' ? 'Copié' : l.copied === 'fail' ? 'Copie impossible' : 'Copier';
  return sheet(l.title, l.sub, () => app.setState({ linkSheet: null }), html`
    ${l.url ? html`
      <span style="height: 48px; box-sizing: border-box; border-radius: 12px; border: 1px solid var(--line2); background: var(--card); display: flex; align-items: center; padding: 0 14px; font: 500 13px ui-monospace, Consolas, monospace; color: var(--soft); -webkit-user-select: all; user-select: all; overflow: hidden"><span class="ell">${l.url}</span></span>
      <span style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
        <button type="button" class="btn btn-primary press" onClick=${() => app.shareLink(/** @type {string} */ (l.url))}>Partager</button>
        <button type="button" class="btn btn-ghost press ell" style="padding: 0 8px" onClick=${() => app.copyLink(/** @type {string} */ (l.url))}>${copyLabel}</button>
      </span>` : null}
    ${l.inviteId != null ? html`<button type="button" class="press" style="height: 44px; border: 0; background: transparent; color: var(--danger); font: 600 14px var(--text); cursor: pointer" onClick=${() => app.revokeInvite(/** @type {number} */ (l.inviteId))}>Révoquer ce lien</button>` : null}`);
}

/** Admin : rôle d'un compte, lien de réinitialisation, suppression. @param {import('../app.js').App} app @param {any} st @param {any} u */
export function accountSheet(app, st, u) {
  const d = dates(app);
  const invited = st.users.filter((/** @type {any} */ x) => !x.invitedByDeleted && x.invitedBy === u.username).map((/** @type {any} */ x) => x.username);
  const sub = invitedBy(u) + 'depuis le ' + d.short(u.createdAt) + (invited.length ? ' · a invité ' + invited.join(', ') : '')
    + ' · ' + plural(u.followedCount, 'série suivie', 'séries suivies') + ' · ' + plural(u.watchedCount, 'épisode vu', 'épisodes vus');
  return sheet(u.username, sub, () => app.setState({ account: null }), html`
    <div class="row" style="padding: 0 4px; min-height: 48px"><span>Rôle</span>${segmented('Rôle', ROLE_SEGS, u.role, (v) => app.setRole(u.id, /** @type {'membre' | 'parrain'} */ (v)), 'flex: none; width: 190px')}</div>
    <button type="button" class="btn btn-ghost press" disabled=${st.resetBusy} onClick=${() => app.createReset(u.id)}>Lien de réinitialisation du mot de passe</button>
    <button type="button" class="press" style="height: 44px; border: 0; background: transparent; color: var(--danger); font: 600 14px var(--text); cursor: pointer" onClick=${() => app.askDeleteUser(u.id)}>Supprimer le compte</button>`);
}

/** Portabilité (RGPD art. 20) : aperçu du fichier JSON, puis téléchargement. @param {import('../app.js').App} app @param {any} x */
export function exportSheetView(app, x) {
  const data = x.data;
  // Sous-titre de hauteur fixe : le titre ne bouge pas quand le texte remplace la place réservée.
  const sub = html`<span style="height: 18px; line-height: 18px; display: flex; align-items: center">${data ? data.sub : phLine(180, 12)}</span>`;
  return sheet('Exporter mes données', sub, () => app.setState({ exportSheet: null }), html`
    <pre style="margin: 0; height: 260px; overflow: auto; box-sizing: border-box; border-radius: 12px; border: 1px solid var(--line2); background: var(--card); padding: 12px; font: 12px/1.45 ui-monospace, Consolas, monospace; color: var(--soft)">${data ? data.preview : ''}</pre>
    <button type="button" class="btn btn-primary press" disabled=${!data} style="opacity: ${data ? 1 : 0.45}" onClick=${() => app.downloadExport()}>Télécharger</button>`);
}

/**
 * Suppression de mon compte (RGPD, droit à l'effacement), protégée par le mot de passe.
 * @param {import('../app.js').App} app @param {import('../app.js').DelSelf} d
 */
export function deleteSelfSheet(app, d) {
  const ok = !!d.pw;
  return html`<div class="overlay backdrop-in">
    <div role="dialog" class="sheetbox sheet-in" aria-modal="true" aria-label="Supprimer ton compte ?" style="padding: 22px 16px calc(24px + var(--safe-bottom)); gap: 10px">
      <h2 class="sheet-title">Supprimer ton compte ?</h2>
      <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: var(--soft)">Ton historique de visionnage, tes séries suivies et tes liens d’invitation seront effacés définitivement.</p>
      <form style="display: flex; flex-direction: column; gap: 10px" onSubmit=${(/** @type {Event} */ ev) => { ev.preventDefault(); if (ok && !d.busy) app.confirmDeleteSelf(); }}>
        ${passwordField({ id: 'mdp-suppr', label: 'Mot de passe', value: d.pw, shown: d.show, autocomplete: 'current-password', invalid: d.bad === 'password',
          onInput: (v) => app.setDelSelf({ pw: v, error: null, bad: null }), onToggle: () => app.setDelSelf({ show: !d.show }) })}
        ${formError(d.error)}
        <button type="submit" class="btn btn-primary press" disabled=${!ok || d.busy} style="${DANGER_BTN}; opacity: ${ok ? 1 : 0.45}">Supprimer mon compte</button>
        <button type="button" class="btn btn-ghost" style="height: 48px; font-size: 14px; font-weight: 600" onClick=${() => app.setState({ delSelf: null })}>Annuler</button>
      </form>
    </div>
  </div>`;
}
