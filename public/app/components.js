// @ts-check
// Éléments d'interface partagés par les vues (fonctions → vnode, sans état propre).
import { html } from '../vendor/htm-preact-3.1.1.js';
import { I } from './icons.js';
import { ROLES, logoUrl, posterUrl } from './format.js';

/** @param {Event} ev */
const dropBroken = (ev) => { /** @type {HTMLImageElement} */ (ev.currentTarget).removeAttribute('src'); };

/**
 * Affiche TMDB ; sans image, fond neutre de la même taille (rien ne bouge).
 * @param {string | null | undefined} path @param {number} w @param {number} h @param {number} r @param {string} [extra]
 */
export function poster(path, w, h, r, extra) {
  const style = `width: ${w}px; height: ${h}px; border-radius: ${r}px; ${extra || ''}`;
  const src = posterUrl(path);
  return src
    ? html`<img class="poster" src=${src} alt="" width=${w} height=${h} loading="lazy" decoding="async" onError=${dropBroken} style=${style} />`
    : html`<span class="poster" aria-hidden="true" style=${style}></span>`;
}

/** Lien sortant discret, ouvert hors de l'appli. @param {string} href @param {string} label */
export function extLink(href, label) {
  return html`<a class="extlink" href=${href} target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
}

/** Logos des plateformes. @param {{ id: number, name: string, logoPath: string | null }[]} items */
export function providersRow(items) {
  return items.map((pv) => {
    const src = logoUrl(pv.logoPath);
    return html`<span class="prov" key=${pv.id}>${src ? html`<img src=${src} alt="" width="28" height="28" loading="lazy" decoding="async" onError=${dropBroken} />` : html`<span class="ph" aria-hidden="true"></span>`}${pv.name}</span>`;
  });
}

/**
 * Sélecteur segmenté : le fond de la position active est un seul élément qui glisse d'une case à l'autre.
 * @param {string} label @param {{ v: string, l: string, c?: string[] }[]} segs c = [fond, texte], absent = neutre
 * @param {string} cur @param {(v: string) => void} onPick @param {string} [style]
 */
export function segmented(label, segs, cur, onPick, style) {
  const idx = Math.max(0, segs.findIndex((g) => g.v === cur));
  /** @param {{ c?: string[] }} g */
  const col = (g) => g.c || ['var(--chip)', 'var(--fg)'];
  return html`<div role="radiogroup" aria-label=${label} style="position: relative; height: 36px; box-sizing: border-box; padding: 2px; border-radius: 10px; border: 1px solid var(--cardline); display: flex; ${style || ''}">
    <span aria-hidden="true" class="seg-thumb" style="width: calc((100% - 4px) / ${segs.length}); background: ${col(segs[idx])[0]}; transform: translateX(${idx * 100}%)"></span>
    ${segs.map((g) => {
      const on = g.v === cur;
      return html`<button type="button" role="radio" class="press" aria-checked=${on ? 'true' : 'false'} onClick=${() => onPick(g.v)}
        style="position: relative; flex: 1 1 0; min-width: 0; border: 0; border-radius: 8px; background: transparent; color: ${on ? col(g)[1] : 'var(--faint)'}; font: 600 12px var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; cursor: pointer">${g.l}</button>`;
    })}
  </div>`;
}

/** Geste en cours sur une poignée de feuille (un seul à la fois). @type {{ el: HTMLElement, y0: number, dy: number, t: number, v: number } | null} */
let drag = null;

/**
 * Glisser l'en-tête d'une feuille vers le bas : elle suit le doigt ; relâchée au-delà d'un quart de sa hauteur
 * (ou lancée vers le bas), elle sort de l'écran puis se ferme, sinon elle revient en place.
 * État transitoire du geste en DOM direct : aucun rendu pendant le glissement.
 * @param {() => void} onClose
 */
function dragToClose(onClose) {
  return {
    /** @param {PointerEvent} ev */
    onPointerDown(ev) {
      if (ev.button !== 0) return;
      const head = /** @type {HTMLElement} */ (ev.currentTarget);
      const el = /** @type {HTMLElement | null} */ (head.closest('.sheetbox'));
      if (!el) return;
      head.setPointerCapture(ev.pointerId);
      el.style.transition = 'none';
      drag = { el, y0: ev.clientY, dy: 0, t: ev.timeStamp, v: 0 };
    },
    /** @param {PointerEvent} ev */
    onPointerMove(ev) {
      if (!drag) return;
      const dy = Math.max(0, ev.clientY - drag.y0);
      const dt = ev.timeStamp - drag.t;
      if (dt > 0) drag.v = (dy - drag.dy) / dt;
      drag.dy = dy; drag.t = ev.timeStamp;
      drag.el.style.transform = `translateY(${dy}px)`;
    },
    onPointerUp() {
      if (!drag) return;
      const { el, dy, v } = drag;
      drag = null;
      const close = dy > el.offsetHeight / 4 || (dy > 20 && v > 0.5);
      el.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = close ? 'translateY(100%)' : '';
      // Minuteur plutôt que transitionend : les transitions sont coupées en mode « moins d'animations ».
      setTimeout(close ? onClose : () => { el.style.transition = ''; }, 200);
    },
    onPointerCancel() {
      if (!drag) return;
      drag.el.style.transition = '';
      drag.el.style.transform = '';
      drag = null;
    },
  };
}

/**
 * Feuille en bas d'écran ; toucher le fond ou glisser l'en-tête vers le bas referme sans rien changer.
 * Seul le contenu défile : la poignée et le titre restent visibles.
 * @param {string} title @param {any} sub texte (ou bloc réservé pendant un chargement), null = aucun
 * @param {() => void} onClose @param {any} content
 */
export function sheet(title, sub, onClose, content) {
  const d = dragToClose(onClose);
  return html`<div class="overlay backdrop-in" onClick=${onClose}>
    <div role="dialog" class="sheetbox sheet-in" aria-modal="true" aria-label=${title} onClick=${(/** @type {Event} */ ev) => ev.stopPropagation()}
      style="max-height: 80%">
      <div onPointerDown=${d.onPointerDown} onPointerMove=${d.onPointerMove} onPointerUp=${d.onPointerUp} onPointerCancel=${d.onPointerCancel}
        style="flex: none; display: flex; flex-direction: column; gap: 14px; padding: 10px 16px 14px; touch-action: none; cursor: grab">
        <span aria-hidden="true" style="align-self: center; width: 36px; height: 4px; border-radius: 2px; background: var(--line2)"></span>
        <span style="display: flex; flex-direction: column; gap: 4px; margin: 0 4px">
          <h2 class="sheet-title">${title}</h2>
          ${sub ? html`<span style="font-size: 13px; color: var(--muted)">${sub}</span>` : null}
        </span>
      </div>
      <div style="flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 0 16px calc(24px + var(--safe-bottom))">
        ${content}
      </div>
    </div>
  </div>`;
}

// Une seule fois, à l'ouverture : fonction stable, Preact ne la rappelle pas à chaque rendu.
/** @param {HTMLElement | null} el */
const centerOnMount = (el) => { if (el) el.scrollIntoView({ block: 'center' }); };

/**
 * Feuille de choix (remplace un <select> natif) : liste avec la valeur courante cochée et centrée à l'ouverture, ou grille 6 × 4 pour les heures.
 * @param {{ title: string, value: string, list: { v: string, l: string }[], onPick: (v: string) => void, grid?: boolean }} p
 * @param {() => void} onClose
 */
export function pickerSheet(p, onClose) {
  /** @param {string} v */
  const choose = (v) => { onClose(); p.onPick(v); };
  return sheet(p.title, null, onClose, p.grid
    ? html`<div role="radiogroup" aria-label=${p.title} class="hourgrid">${p.list.map((o) => html`<button type="button" role="radio" class="hour press" aria-checked=${o.v === p.value ? 'true' : 'false'} onClick=${() => choose(o.v)}>${o.l}</button>`)}</div>`
    : html`<div role="radiogroup" aria-label=${p.title} style="display: flex; flex-direction: column; gap: 2px">${p.list.map((o) => html`<button type="button" role="radio" class="opt press" aria-checked=${o.v === p.value ? 'true' : 'false'} ref=${o.v === p.value ? centerOnMount : null} onClick=${() => choose(o.v)}><span>${o.l}</span>${o.v === p.value ? I.check(null, 18, 3) : null}</button>`)}</div>`);
}

/**
 * Confirmation (coche de saison, suppression de compte). danger = bouton rouge.
 * @param {{ title: string, text: string, ok: string, action: () => void, danger?: boolean }} c @param {() => void} onCancel
 */
export function confirmSheet(c, onCancel) {
  return html`<div class="overlay backdrop-in">
    <div role="dialog" class="sheetbox sheet-in" aria-modal="true" aria-label=${c.title} style="padding: 22px 16px calc(24px + var(--safe-bottom)); gap: 10px">
      <h2 class="sheet-title">${c.title}</h2>
      <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: var(--soft)">${c.text}</p>
      <button type="button" class="btn btn-primary press" style=${c.danger ? DANGER_BTN : null} onClick=${() => c.action()}>${c.ok}</button>
      <button type="button" class="btn btn-ghost" style="height: 48px; font-size: 14px; font-weight: 600" onClick=${onCancel}>Annuler</button>
    </div>
  </div>`;
}

/** Bouton principal d'une action destructrice. */
export const DANGER_BTN = 'background: var(--danger); color: var(--on-danger)';

/**
 * Champ de saisie (connexion, inscription, confirmation par mot de passe). invalid = bordure rouge (même épaisseur).
 * @param {{ id: string, label: string, value: string, onInput: (v: string) => void, type?: string, autocomplete?: string, extra?: any, invalid?: boolean, plain?: boolean }} f
 * plain : nom d'utilisateur (ni majuscule automatique ni correction)
 */
export function field(f) {
  return html`<label for=${f.id} style="display: flex; flex-direction: column; gap: 6px">
    <span style="font-size: 13px; font-weight: 600; color: var(--soft)">${f.label}</span>
    <span style="height: 50px; box-sizing: border-box; border-radius: 12px; border: 1px solid ${f.invalid ? 'var(--danger)' : 'var(--line2)'}; background: var(--card); display: flex; align-items: center; padding: 0 4px 0 14px">
      <input id=${f.id} type=${f.type || 'text'} value=${f.value} autocomplete=${f.autocomplete || 'off'}
        autocapitalize=${f.plain ? 'none' : null} autocorrect=${f.plain ? 'off' : null} spellcheck=${f.plain ? false : null}
        onInput=${(/** @type {Event} */ ev) => f.onInput(/** @type {HTMLInputElement} */ (ev.currentTarget).value)}
        style="flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--fg); font: 500 16px var(--text)" />${f.extra || null}
    </span>
  </label>`;
}

/**
 * Mot de passe avec bouton pour l'afficher.
 * @param {{ id: string, label: string, value: string, shown: boolean, onInput: (v: string) => void, onToggle: () => void, autocomplete: string, invalid?: boolean }} p
 */
export function passwordField(p) {
  return field({
    id: p.id, label: p.label, value: p.value, onInput: p.onInput, type: p.shown ? 'text' : 'password', autocomplete: p.autocomplete, invalid: p.invalid, plain: true,
    extra: html`<button type="button" class="iconbtn" aria-label=${p.shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} aria-pressed=${p.shown ? 'true' : 'false'} style="color: var(--muted)" onClick=${p.onToggle}>${p.shown ? I.eyeOff() : I.eye()}</button>`,
  });
}

/** Message d'erreur d'un formulaire : ligne toujours réservée, rien ne bouge quand il apparaît. @param {string | null} text */
export function formError(text) {
  return html`<span aria-live="polite" style="min-height: 18px; font-size: 13px; line-height: 18px; color: var(--danger)">${text || ''}</span>`;
}

/** Pastille de rôle (absente si le rôle est inconnu). @param {string | null | undefined} role */
export function roleChip(role) {
  const c = role ? ROLES[role] : null;
  return c ? html`<span style="flex: none; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: ${c[1]}; color: ${c[2]}">${c[0]}</span>` : null;
}

/** Initiale dans un rond. @param {string} name @param {number} [size] */
export function avatar(name, size) {
  const z = size || 40;
  return html`<span aria-hidden="true" style="flex: none; width: ${z}px; height: ${z}px; border-radius: ${z / 2}px; background: var(--chip); color: var(--soft); font: 700 ${Math.round(z * 0.4)}px var(--display); display: flex; align-items: center; justify-content: center">${name.charAt(0).toUpperCase()}</span>`;
}

/**
 * Ligne de liste (parrainages, comptes) : pastille, titre, sous-titre, élément à droite ; cliquable si onClick.
 * @param {any} lead @param {string} title @param {string} sub @param {any} right @param {(() => void) | null} onClick @param {boolean} [faded]
 */
export function listRow(lead, title, sub, right, onClick, faded) {
  const inner = html`${lead}<span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px">
      <span class="ell" style="font-size: 15px; font-weight: 600">${title}</span>
      <span class="ell" style="font-size: 12px; color: var(--muted)">${sub}</span>
    </span>${right}`;
  const style = 'min-height: 64px; display: flex; align-items: center; gap: 12px; padding: 0 4px; opacity: ' + (faded ? 0.55 : 1);
  return onClick
    ? html`<button type="button" onClick=${onClick} style="${style}; width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer">${inner}</button>`
    : html`<div style=${style}>${inner}</div>`;
}

/** Ligne de liste réservée pendant un chargement. */
export function listRowPlaceholder() {
  return html`<div aria-hidden="true" style="min-height: 64px; display: flex; align-items: center; gap: 12px; padding: 0 4px">
    <span class="ph-line" style="flex: none; width: 40px; height: 40px; border-radius: 20px"></span>
    <span style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px">${phLine(140, 13)}${phLine(100, 10)}</span>
  </div>`;
}

/**
 * Carte qui se glisse (façon Gmail) : l'action se révèle dessous pendant le glissement.
 * @param {any} sw état du geste (App.swipe) @param {number} height @param {number} radius @param {any} label
 * @param {any} inner @param {() => void} onClick @param {string} cardStyle
 */
export function swipeShell(sw, height, radius, label, inner, onClick, cardStyle) {
  return html`
    <div style="position: relative; height: ${height}px; border-radius: ${radius}px; overflow: hidden; background: ${sw.bg}">
      <div class="reveal" aria-hidden="true" style="color: ${sw.fg}; opacity: ${sw.op}"><span>${label}</span><span>${label}</span></div>
      <button type="button" class="sw swbtn" onClick=${onClick} onPointerDown=${sw.down} onPointerMove=${sw.move} onPointerUp=${sw.up} onPointerCancel=${sw.cancel}
        style="border-radius: ${radius}px; ${cardStyle}; transform: translateX(${sw.dx}px); transition: ${sw.tr}">${inner}</button>
    </div>`;
}

/** Même bordure dans les deux états (couleur seulement) : la transition reste fluide et la taille ne change pas. @param {boolean} on @param {boolean} enabled */
export function dot(on, enabled) {
  return {
    on,
    border: '2px solid ' + (on ? 'var(--ok)' : enabled ? 'var(--tick-off)' : 'var(--chip)'),
    bg: on ? 'var(--ok)' : 'transparent',
    tick: on ? 'var(--on-ok)' : enabled ? 'var(--tick-off)' : 'transparent',
  };
}

/** Coché : léger rebond (scale 0,9 → 1 avec dépassement), le nœud DOM est conservé donc seule la transition joue. @param {ReturnType<typeof dot>} d @param {number} [size] */
export function dotView(d, size) {
  return html`<span class="dot" style="border: ${d.border}; background: ${d.bg}; transform: scale(${d.on ? 1 : 0.9})">${I.check(d.tick, size || 15, 3.5)}</span>`;
}

/** @param {string} title @param {any} [right] */
export function header(title, right) {
  return html`<header class="hdr"><h1 class="h1">${title}</h1>${right ? html`<span style="font-size: 13px; color: var(--muted)">${right}</span>` : null}</header>`;
}

/**
 * En-tête de l'explorateur : retour + fil d'Ariane (éléments cliquables, puis l'élément courant).
 * @param {() => void} onBack @param {{ label: string, onClick: () => void, shrink?: boolean }[]} crumbs @param {string} current
 * @param {boolean} [currentShrinks] l'élément courant est un nom de série (peut être tronqué)
 */
export function navHeader(onBack, crumbs, current, currentShrinks) {
  return html`<header class="hdr nav">
    <button type="button" class="iconbtn" aria-label="Retour" onClick=${onBack}>${I.back()}</button>
    ${crumbs.map((c) => html`<button type="button" class=${'crumb' + (c.shrink ? ' ell' : '')} style=${c.shrink ? null : 'flex: none'} onClick=${c.onClick}>${c.label}</button><span aria-hidden="true" style="flex: none; color: var(--dim)">›</span>`)}
    <span class=${currentShrinks ? 'ell' : null} aria-current="page" style=${currentShrinks ? 'flex: 1; min-width: 0; font-size: 15px; font-weight: 600; padding: 0 4px' : 'flex: none; font-size: 15px; font-weight: 600; padding: 0 4px'}>${current}</span>
  </header>`;
}

/** Ligne de texte réservée pendant un chargement. @param {number | string} w @param {number} [h] */
export function phLine(w, h) {
  return html`<span class="ph-line" aria-hidden="true" style="width: ${typeof w === 'number' ? w + 'px' : w}; height: ${h || 12}px"></span>`;
}

/** Échec de chargement : message court + nouvel essai. @param {() => void} retry */
export function loadError(retry) {
  return html`<div style="display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 8px 4px">
    <p class="note">Chargement impossible</p>
    <button type="button" class="btn btn-ghost press" style="height: 44px; padding: 0 16px; font-size: 14px" onClick=${retry}>Réessayer</button>
  </div>`;
}
