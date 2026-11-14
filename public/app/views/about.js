// @ts-check
// « À propos », depuis Profil : version, licence et code source (AGPL), sources des données, bibliothèques utilisées.
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { extLink, loadError, navHeader, phLine } from '../components.js';

/** Bibliothèques livrées avec l'appli (dépendances directes). */
const LIBS = [
  { name: 'Hono', license: 'MIT', url: 'https://hono.dev' },
  { name: 'web-push', license: 'MPL-2.0', url: 'https://github.com/web-push-libs/web-push' },
  { name: 'Preact', license: 'MIT', url: 'https://preactjs.com' },
  { name: 'htm', license: 'Apache-2.0', url: 'https://github.com/developit/htm' },
];

/** « AGPL-3.0-or-later » → « AGPL-3.0 ou ultérieure ». @param {string} id */
const licenseLabel = (id) => id.replace(/-or-later$/, ' ou ultérieure').replace(/-only$/, '');

/** @param {import('../app.js').App} app @param {any} st */
export function viewAbout(app, st) {
  const info = st.about;
  const muted = 'font-size: 14px; color: var(--muted)';
  /** Ligne libellé / valeur ; valeur null = en chargement. @param {string} label @param {string | null} value */
  const row = (label, value) => html`<div class="row" style="padding-right: 16px"><span>${label}</span>
    <span style=${muted}>${value === null ? phLine(60, 12) : value}</span></div>`;
  const p = 'margin: 0; font-size: 13px; line-height: 1.5; color: var(--muted)';
  return html`
    <div class="screen">
      ${navHeader(() => app.back(), [], 'À propos', true)}
      <div class="scroll body" style="gap: 22px">
        ${st.errs.about && !info ? loadError(() => app.loadAbout()) : null}
        <section class="group">
          ${row('Version', info ? info.version : null)}
          ${row('Licence', info ? licenseLabel(info.license) : null)}
        </section>
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 class="eyebrow">Logiciel libre</h2>
          <p style=${p}>Nexode est distribué sous licence GNU AGPL : tu peux l’utiliser, l’étudier, le modifier et le redistribuer.
            Toute version modifiée mise en ligne doit publier son code source.</p>
          ${info && info.source ? extLink(info.source, 'Code source') : null}
          ${extLink('https://www.gnu.org/licenses/agpl-3.0.html', 'Texte de la licence')}
        </section>
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 class="eyebrow">Données</h2>
          <p style=${p}>Séries, épisodes et affiches : TMDB. Ce produit utilise l’API TMDB mais n’est ni approuvé ni certifié par TMDB.</p>
          ${extLink('https://www.themoviedb.org', 'TMDB')}
          <p style=${p}>Plateformes de diffusion : JustWatch.</p>
          ${extLink('https://www.justwatch.com', 'JustWatch')}
        </section>
        <section style="display: flex; flex-direction: column; gap: 8px">
          <h2 class="eyebrow">Bibliothèques</h2>
          <section class="group">
            ${LIBS.map((l) => html`<a class="row" href=${l.url} target="_blank" rel="noopener noreferrer"
              style="padding-right: 16px; color: inherit; text-decoration: none"><span>${l.name}</span><span style=${muted}>${l.license}</span></a>`)}
          </section>
        </section>
      </div>
    </div>`;
}
