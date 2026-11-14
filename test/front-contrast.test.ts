// Contrastes de la charte (docs/charte.md) : lit les variables de public/app/style.css et vérifie chaque couple texte / fond
// dans les deux thèmes. Texte : 4,5:1 (WCAG AA). Élément graphique qui porte une information (coche, icône) : 3:1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/app/style.css', import.meta.url), 'utf8');

/** Variables `--nom: #RRGGBB` du premier bloc dont le sélecteur est exactement `selector`. */
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, `bloc ${selector} introuvable dans style.css`);
  const body = css.slice(start, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) out.set(m[1] as string, (m[2] as string).toUpperCase());
  return out;
}
const dark = tokens(':root');
const light = new Map([...dark, ...tokens(':root[data-theme="light"]')]);

const channel = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const SURFACES = ['bg', 'card', 'sheet', 'bar'];
const TEXT = 4.5, GRAPHIC = 3;
/** Rôle → fonds sur lesquels il apparaît. Tenu à jour avec le tableau des rôles de docs/charte.md. */
const PAIRS: { fg: string; on: string[]; min: number }[] = [
  { fg: 'fg', on: [...SURFACES, 'chip', 'toast'], min: TEXT },
  { fg: 'soft', on: SURFACES, min: TEXT },
  { fg: 'muted', on: [...SURFACES, 'chip'], min: TEXT },
  { fg: 'faint', on: [...SURFACES, 'chip2'], min: TEXT },
  { fg: 'accent', on: [...SURFACES, 'chip', 'accent-bg', 'toast'], min: TEXT },
  { fg: 'on-accent', on: ['accent-solid'], min: TEXT },
  { fg: 'ok', on: SURFACES, min: TEXT },
  { fg: 'ok-fg', on: ['ok-bg'], min: TEXT },
  { fg: 'on-armed', on: ['ok-strong'], min: TEXT },
  { fg: 'danger', on: SURFACES, min: TEXT },
  { fg: 'on-danger', on: ['danger'], min: TEXT },
  { fg: 'hist', on: ['hist-bg'], min: TEXT },
  { fg: 'hist-strong', on: ['hist-bg'], min: TEXT },
  { fg: 'dim', on: ['bg', 'card'], min: GRAPHIC },
  { fg: 'on-ok', on: ['ok'], min: GRAPHIC },
  { fg: 'hist-check', on: ['hist-bg'], min: GRAPHIC },
];

for (const [name, theme] of [['sombre', dark], ['clair', light]] as const) {
  test(`contrastes du thème ${name}`, () => {
    const fails: string[] = [];
    for (const p of PAIRS) {
      for (const bg of p.on) {
        const a = theme.get(p.fg), b = theme.get(bg);
        assert.ok(a && b, `variable --${a ? bg : p.fg} absente du thème ${name}`);
        const r = contrast(a, b);
        if (r < p.min) fails.push(`--${p.fg} ${a} sur --${bg} ${b} : ${r.toFixed(2)} < ${p.min}`);
      }
    }
    assert.deepEqual(fails, []);
  });
}
