// @ts-check
// Pages hors appli : connexion, inscription par lien d'invitation, nouveau mot de passe, lien invalide.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { PASSWORD_MIN, cleanName, nameOk, nameProblem, passwordLength, passwordOk } from '../auth.js';
import { field, formError, passwordField, phLine } from '../components.js';

/** @param {import('../app.js').App} app @param {any} st */
export function viewAuth(app, st) {
  const a = st.auth, f = st.form;
  /** @param {Record<string, any>} patch */
  const setF = (patch) => app.setForm(patch);
  const name = cleanName(f.name);
  /** @param {string} label @param {string} autocomplete */
  const pw = (label, autocomplete) => passwordField({
    id: 'mdp', label, value: f.pw, shown: f.show, autocomplete, invalid: f.bad === 'password',
    onInput: (v) => setF({ pw: v, error: null, bad: f.bad === 'password' ? null : f.bad }), onToggle: () => setF({ show: !f.show }),
  });
  /** @param {boolean} [refused] nom refusé pendant la saisie (inscription) */
  const nameField = (refused) => field({
    id: 'nom', label: 'Nom d’utilisateur', value: f.name, autocomplete: 'username', plain: true, invalid: f.bad === 'name' || !!refused,
    onInput: (v) => setF({ name: v, error: null, bad: f.bad === 'name' ? null : f.bad }),
  });
  const pwHint = html`<span style="margin-top: -10px; font-size: 12px; color: ${passwordLength(f.pw) >= PASSWORD_MIN ? 'var(--ok)' : 'var(--faint)'}">${PASSWORD_MIN} caractères minimum</span>`;
  // Sous-titre des pages ouvertes par un lien : place réservée pendant la lecture du lien, rien ne bouge à l'arrivée.
  /** @param {string | null} text */
  const linkSub = (text) => html`<span style="min-height: 20px; display: flex; align-items: center; font-size: 14px; color: var(--muted)">${a.info ? text : a.infoFailed ? '' : phLine(160, 12)}</span>`;

  let title, sub = null, body, ok, label, error = f.error;
  if (a.screen === 'invalid') {
    title = 'Lien invalide';
    sub = html`<span style="font-size: 14px; color: var(--muted)">Ce lien n’est plus valable.</span>`;
    body = null;
    ok = true;
    label = 'Se connecter';
    error = null;
  } else if (a.screen === 'signup') {
    title = 'Créer ton compte';
    sub = linkSub(a.info && a.info.invitedBy ? 'Invitation de ' + a.info.invitedBy : null);
    body = html`${nameField(!!nameProblem(name))}${pw('Mot de passe', 'new-password')}${pwHint}`;
    ok = nameOk(name) && passwordOk(f.pw);
    label = 'Créer mon compte';
    error = f.error || nameProblem(name);
  } else if (a.screen === 'reset') {
    title = 'Nouveau mot de passe';
    sub = linkSub(a.info ? 'Compte : ' + a.info.username : null);
    // Nom du compte, invisible : les gestionnaires de mots de passe rattachent le nouveau mot de passe à ce compte.
    body = html`${a.info ? html`<input type="text" autocomplete="username" value=${a.info.username} readonly hidden />` : null}
      ${pw('Nouveau mot de passe', 'new-password')}${pwHint}`;
    ok = passwordOk(f.pw);
    label = 'Enregistrer';
  } else {
    title = 'Connexion';
    body = html`${nameField()}${pw('Mot de passe', 'current-password')}
      <span style="font-size: 12px; line-height: 1.5; color: var(--faint)">Mot de passe oublié : l’administrateur peut t’envoyer un lien de réinitialisation.</span>`;
    ok = !!name && !!f.pw;
    label = 'Se connecter';
  }
  const enabled = ok && !f.busy && !f.wait;
  return html`<div class="screen v-fwd" style="overflow-y: auto">
    <form onSubmit=${(/** @type {Event} */ ev) => { ev.preventDefault(); if (enabled) app.submitAuth(); }} style="max-width: 380px; margin: 0 auto; padding: 56px 24px 32px; display: flex; flex-direction: column; gap: 18px">
      <span style="display: flex; align-items: center; gap: 10px; color: var(--accent); font: 700 15px var(--display)">${I.tv()}Suivi de séries</span>
      <span style="display: flex; flex-direction: column; gap: 6px; margin: 12px 0 6px">
        <h1 class="h1" style="font-size: 26px">${title}</h1>
        ${sub}
      </span>
      ${body}
      ${a.screen === 'invalid' ? null : formError(error)}
      <button type="submit" class="btn btn-primary press" disabled=${!enabled} style="margin-top: 6px; opacity: ${ok && !f.wait ? 1 : 0.45}">${label}</button>
    </form>
  </div>`;
}
