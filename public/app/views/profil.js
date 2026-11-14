// @ts-check
// Onglet « Profil » : thème (local à l'appareil), pays, mise de côté, notifications (compte, via /api/me),
// parrainages et comptes selon le rôle, export des données, déconnexion, suppression du compte.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { I } from '../icons.js';
import { COUNTRIES, HOURS, THEMES, THRESHOLDS, plural } from '../format.js';
import { canInvite } from '../auth.js';
import { header, loadError, phLine, roleChip, segmented } from '../components.js';

/** @param {import('../app.js').App} app @param {any} st */
export function viewProfil(app, st) {
  const me = st.me;
  // Ligne de réglage : la valeur s'ouvre dans une feuille en bas d'écran (liste, ou grille pour les heures).
  /** @param {string} label @param {string | null} value @param {{ v: string, l: string }[]} list @param {(v: string) => void} onPick @param {boolean} [grid] */
  const pick = (label, value, list, onPick, grid) => html`<button type="button" class="row pickrow" disabled=${value === null}
    onClick=${() => { if (value !== null) app.setState({ picker: { title: label, value, list, onPick, grid: !!grid } }); }}>
    <span>${label}</span><span class="pickval">${value === null ? ' ' : (list.find((o) => o.v === value) || list[0]).l}${I.down()}</span></button>`;
  /** Ligne qui ouvre un écran ou une feuille. @param {string} label @param {string | null} right @param {() => void} onClick */
  const navRow = (label, right, onClick) => html`<button type="button" class="row pickrow" onClick=${onClick}>
    <span>${label}</span><span style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted)">${right}${I.chev()}</span></button>`;
  const dangerRow = 'border: 0; border-top: 1px solid var(--cardline); background: transparent; color: var(--danger); font: 400 15px var(--text); cursor: pointer';
  const role = me ? me.role : null;
  const pending = st.invites ? st.invites.filter((/** @type {any} */ x) => x.status === 'pending').length : 0;
  const name = me ? me.username : '';
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
          ${pick('Pays', me ? me.country : null, COUNTRIES, (v) => app.patchMe({ country: v }))}
          ${pick('Mettre de côté après', me ? String(me.shelveAfterDays) : null, THRESHOLDS, (v) => app.patchMe({ shelveAfterDays: Number(v) }))}
        </section>
        <section class="group">
          <div class="row" style="padding-right: 12px">
            <span>Notifications</span>
            <button type="button" aria-pressed=${me && me.notifOn ? 'true' : 'false'} aria-label="Notifications" disabled=${!me} onClick=${() => { if (me) app.patchMe({ notifOn: !me.notifOn }); }}
              style="flex: none; width: 52px; height: 32px; border-radius: 16px; border: 0; background: ${me && me.notifOn ? 'var(--ok)' : 'var(--line-strong)'}; position: relative; cursor: pointer">
              <span style="position: absolute; top: 3px; left: ${me && me.notifOn ? 23 : 3}px; width: 26px; height: 26px; border-radius: 13px; background: var(--knob); transition: left 0.18s ease"></span>
            </button>
          </div>
          ${me && me.notifOn ? pick('Heure du rappel', String(me.notifHour), HOURS, (v) => app.patchMe({ notifHour: Number(v) }), true) : null}
        </section>
        ${canInvite(role) ? html`<section class="group">
          ${navRow('Parrainages', pending ? plural(pending, 'lien en attente', 'liens en attente') : null, () => app.openInvites())}
          ${role === 'admin' ? navRow('Comptes', st.users ? String(st.users.length) : null, () => app.openAdmin()) : null}
        </section>` : null}
        <section class="group">
          ${navRow('Exporter mes données', null, () => app.openExport())}
          <button type="button" class="row" style=${dangerRow} onClick=${() => app.logout()}>Se déconnecter</button>
          <button type="button" class="row" style=${dangerRow} onClick=${() => app.askDeleteSelf()}>Supprimer mon compte</button>
        </section>
        <p style="margin: 0; font-size: 11px; line-height: 1.5; color: var(--faint)">Données et affiches : TMDB. Ce produit utilise l’API TMDB mais n’est ni approuvé ni certifié par TMDB. Plateformes : JustWatch.</p>
      </div>
    </div>`;
}
