// @ts-check
// Onglet « Profil » : thème (local à l'appareil), pays, mise de côté, notifications (activation par appareil, heure par compte),
// parrainages et comptes selon le rôle, export des données, déconnexion, suppression du compte, « À propos ».
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { HOURS, THEMES, THRESHOLDS, countryChoices, plural } from '../format.js';
import { canInvite } from '../auth.js';
import { header, loadError, phLine, roleChip, segmented } from '../components.js';

/** Mention sous « Notifications » quand l'appareil ne peut pas les activer. @type {Record<string, string>} */
const PUSH_NOTES = {
  denied: 'Bloquées dans les réglages du navigateur',
  install: 'Pour les recevoir, ajouter l’appli à l’écran d’accueil (Partager › Sur l’écran d’accueil)',
  unsupported: 'Ce navigateur ne les reçoit pas',
  unavailable: 'Pas encore configurées sur le serveur',
};

/** @param {import('../app.js').App} app @param {any} st */
export function viewProfil(app, st) {
  const me = st.me;
  // Ligne de réglage : la valeur s'ouvre dans une feuille en bas d'écran (liste, ou grille pour les heures).
  // ready = false : valeur affichée, feuille pas encore disponible (liste en chargement).
  /** @param {string} label @param {string | null} value @param {{ v: string, l: string }[]} list @param {(v: string) => void} onPick @param {boolean} [grid] @param {boolean} [ready] */
  const pick = (label, value, list, onPick, grid, ready = true) => html`<button type="button" class="row pickrow" disabled=${value === null || !ready}
    onClick=${() => { if (value !== null && ready) app.setState({ picker: { title: label, value, list, onPick, grid: !!grid } }); }}>
    <span>${label}</span><span class="pickval">${value === null ? ' ' : (list.find((o) => o.v === value) || list[0]).l}${I.down()}</span></button>`;
  /** Ligne qui ouvre un écran ou une feuille. @param {string} label @param {string | null} right @param {() => void} onClick */
  const navRow = (label, right, onClick) => html`<button type="button" class="row pickrow" onClick=${onClick}>
    <span>${label}</span><span style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted)">${right}${I.chev()}</span></button>`;
  const dangerRow = 'border: 0; border-top: 1px solid var(--cardline); background: transparent; color: var(--danger); font: 400 15px var(--text); cursor: pointer';
  const role = me ? me.role : null;
  const pending = st.invites ? st.invites.filter((/** @type {any} */ x) => x.status === 'pending').length : 0;
  const name = me ? me.username : '';
  // Notifications : activées par appareil (st.push, voir push.js) ; l'heure est un réglage du compte.
  const pushOn = st.push === 'on';
  const switchable = (st.push === 'on' || st.push === 'off') && !st.pushBusy && !!me;
  const note = st.push ? PUSH_NOTES[st.push] || null : null;
  const count = st.mine ? st.mine.rows.filter((/** @type {any} */ r) => r.relation !== 'none').length : null;
  return html`
    <div class="screen">
      ${header('Profil')}
      <div class="scroll body" style="gap: 22px; padding-top: 18px">
        <div style="display: flex; align-items: center; gap: 14px">
          <span aria-hidden="true" style="flex: none; width: 52px; height: 52px; border-radius: 26px; background: var(--accent-bg); color: var(--accent); font: 700 20px var(--display); display: flex; align-items: center; justify-content: center">${name.charAt(0).toUpperCase()}</span>
          <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px">
            ${me ? html`<span style="display: flex; align-items: center; gap: 8px; min-width: 0"><span class="ell" style="font-size: 16px; line-height: 20px; font-weight: 600">${name}</span>${roleChip(role)}</span>`
              : html`<span style="height: 20px; display: flex; align-items: center">${phLine(120, 14)}</span>`}
            <span style="font-size: 13px; color: var(--muted)">${count === null ? ' ' : plural(count, 'série suivie', 'séries suivies')}</span>
          </span>
        </div>
        ${st.errs.me && !me ? loadError(() => app.loadMe()) : null}
        <section class="group">
          <div class="row" style="padding-right: 12px"><span>Thème</span>${segmented('Thème', THEMES, st.theme, (v) => app.setTheme(v), 'flex: none; width: 210px')}</div>
          ${pick('Pays', me ? me.country : null, me ? countryChoices([...new Set([...(st.countries || []), me.country])]) : [],
            (v) => app.patchMe({ country: v }), false, !!st.countries)}
          ${pick('Mettre de côté après', me ? String(me.shelveAfterDays) : null, THRESHOLDS, (v) => app.patchMe({ shelveAfterDays: Number(v) }))}
        </section>
        <section class="group">
          <div class="row" style="padding-right: 12px">
            <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px">
              <span>Notifications</span>
              ${note ? html`<span style="font-size: 12px; line-height: 1.4; color: var(--muted)">${note}</span>` : null}
            </span>
            <button type="button" aria-pressed=${pushOn ? 'true' : 'false'} aria-label="Notifications sur cet appareil" disabled=${!switchable}
              onClick=${() => { if (switchable) app.setPush(!pushOn); }}
              style="flex: none; width: 52px; height: 32px; border-radius: 16px; border: 0; background: ${pushOn ? 'var(--ok)' : 'var(--line-strong)'}; opacity: ${switchable || pushOn ? 1 : 0.5}; position: relative; cursor: pointer">
              <span style="position: absolute; top: 3px; left: ${pushOn ? 23 : 3}px; width: 26px; height: 26px; border-radius: 13px; background: var(--knob); transition: left 0.18s ease"></span>
            </button>
          </div>
          ${pushOn ? pick('Heure du rappel', me ? String(me.notifHour) : null, HOURS, (v) => app.patchMe({ notifHour: Number(v) }), true) : null}
          ${pushOn ? html`<button type="button" class="row pickrow" disabled=${st.pushBusy} onClick=${() => app.testPush()}><span>Envoyer une notification de test</span></button>` : null}
        </section>
        ${canInvite(role) ? html`<section class="group">
          ${navRow('Parrainages', pending ? plural(pending, 'lien en attente', 'liens en attente') : null, () => app.openInvites())}
          ${role === 'admin' ? navRow('Comptes', st.users ? String(st.users.length) : null, () => app.openAdmin()) : null}
        </section>` : null}
        <section class="group">
          ${navRow('Importer un historique', null, () => app.openImport())}
          ${navRow('Exporter mes données', null, () => app.openExport())}
          <button type="button" class="row" style=${dangerRow} onClick=${() => app.logout()}>Se déconnecter</button>
          <button type="button" class="row" style=${dangerRow} onClick=${() => app.askDeleteSelf()}>Supprimer mon compte</button>
        </section>
        <section class="group">
          ${navRow('À propos', null, () => app.openAbout())}
        </section>
      </div>
    </div>`;
}
