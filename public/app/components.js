// @ts-check
// Éléments d'interface partagés par les vues (fonctions → vnode, sans état propre).
import { html } from '../vendor/htm-preact-3.1.1.js';
import { I } from './icons.js';
import { logoUrl, posterUrl } from './format.js';

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

/**
 * Feuille en bas d'écran ; toucher le fond referme sans rien changer.
 * @param {string} title @param {string | null} sub @param {() => void} onClose @param {any} content
 */
export function sheet(title, sub, onClose, content) {
  return html`<div class="overlay backdrop-in" onClick=${onClose}>
    <div role="dialog" class="sheetbox sheet-in" aria-modal="true" aria-label=${title} onClick=${(/** @type {Event} */ ev) => ev.stopPropagation()}
      style="max-height: 80%; overflow-y: auto; padding: 10px 16px calc(24px + var(--safe-bottom)); gap: 14px">
      <span aria-hidden="true" style="align-self: center; width: 36px; height: 4px; border-radius: 2px; background: var(--line2)"></span>
      <span style="display: flex; flex-direction: column; gap: 4px; margin: 0 4px">
        <h2 class="sheet-title">${title}</h2>
        ${sub ? html`<span style="font-size: 13px; color: var(--muted)">${sub}</span>` : null}
      </span>
      ${content}
    </div>
  </div>`;
}

/**
 * Feuille de choix (remplace un <select> natif) : liste avec la valeur courante cochée, ou grille 6 × 4 pour les heures.
 * @param {{ title: string, value: string, list: { v: string, l: string }[], onPick: (v: string) => void, grid?: boolean }} p
 * @param {() => void} onClose
 */
export function pickerSheet(p, onClose) {
  /** @param {string} v */
  const choose = (v) => { onClose(); p.onPick(v); };
  return sheet(p.title, null, onClose, p.grid
    ? html`<div role="radiogroup" aria-label=${p.title} class="hourgrid">${p.list.map((o) => html`<button type="button" role="radio" class="hour press" aria-checked=${o.v === p.value ? 'true' : 'false'} onClick=${() => choose(o.v)}>${o.l}</button>`)}</div>`
    : html`<div role="radiogroup" aria-label=${p.title} style="display: flex; flex-direction: column; gap: 2px">${p.list.map((o) => html`<button type="button" role="radio" class="opt press" aria-checked=${o.v === p.value ? 'true' : 'false'} onClick=${() => choose(o.v)}><span>${o.l}</span>${o.v === p.value ? I.check(null, 18, 3) : null}</button>`)}</div>`);
}

/**
 * Confirmation (coche de saison).
 * @param {{ title: string, text: string, ok: string, action: () => void }} c @param {() => void} onCancel
 */
export function confirmSheet(c, onCancel) {
  return html`<div class="overlay backdrop-in">
    <div role="dialog" class="sheetbox sheet-in" aria-modal="true" aria-label=${c.title} style="padding: 22px 16px calc(24px + var(--safe-bottom)); gap: 10px">
      <h2 class="sheet-title">${c.title}</h2>
      <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.5; color: var(--soft)">${c.text}</p>
      <button type="button" class="btn btn-primary press" onClick=${() => c.action()}>${c.ok}</button>
      <button type="button" class="btn btn-ghost" style="height: 48px; font-size: 14px; font-weight: 600" onClick=${onCancel}>Annuler</button>
    </div>
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
