// Génère tous les fichiers de la marque depuis la construction décrite dans docs/charte.md :
//   docs/logo/*.svg (sources), public/icons/*.png et icon.svg (appli installée, onglet, notifications),
//   public/app/brand.js (nom écrit en tracés, affiché par le composant Wordmark).
// Sur le PC seulement (dépendances de développement) : node tools/brand.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import opentype from 'opentype.js';

const root = new URL('../', import.meta.url);
const out = (p: string, data: string | Uint8Array) => { writeFileSync(new URL(p, root), data); console.log('écrit', p); };
const f = (n: number) => +n.toFixed(2);

// --- Construction (boîte 512, angles depuis midi, sens horaire ; voir docs/charte.md) --------------------------------

type Shape =
  | { kind: 'arc'; cx: number; cy: number; R: number; from: number; to: number; sw: number }
  | { kind: 'tri'; pts: [number, number][]; sj: number }
  | { kind: 'dot'; x: number; y: number; r: number; op: number };
type Spec = { R: number; c: number; sw: number; arc: [number, number]; arrow: { w: number; h: number; sj: number }; trail: { deg: number; r: number; op: number }[] };

const ICON: Spec = { R: 150, c: 256, sw: 44, arc: [188, 405], arrow: { w: 80, h: 92, sj: 20 }, trail: [{ deg: 130, r: 15, op: 0.9 }, { deg: 158, r: 11, op: 0.55 }] };
// Nom écrit : réduction ×38/150 dans une boîte de 100, trait 20 (graisse des jambages de Space Grotesk 700), arc raccourci
// et traîne décalée pour garder l'écart entre les éléments (contrôlé plus bas).
const K = 38 / 150;
const WORD: Spec = { R: 38, c: 50, sw: 20, arc: [201, 393], arrow: { w: 80 * K, h: 92 * K, sj: 20 * K },
  trail: [{ deg: 138, r: 15 * K * 1.3, op: 0.9 }, { deg: 166, r: 11 * K * 1.3, op: 0.55 }] };

const pol = (c: number, R: number, deg: number): [number, number] => {
  const a = deg * Math.PI / 180;
  return [c + R * Math.sin(a), c - R * Math.cos(a)];
};
/** Triangle de centre de gravité p, pointe dans la direction dir (même convention d'angle). */
function triangle(p: [number, number], dir: number, w: number, h: number): [number, number][] {
  const a = dir * Math.PI / 180, d = [Math.sin(a), -Math.cos(a)] as const, n = [Math.cos(a), Math.sin(a)] as const;
  const b = [p[0] - d[0] * w / 3, p[1] - d[1] * w / 3] as const;
  return [[p[0] + d[0] * 2 * w / 3, p[1] + d[1] * 2 * w / 3], [b[0] + n[0] * h / 2, b[1] + n[1] * h / 2], [b[0] - n[0] * h / 2, b[1] - n[1] * h / 2]];
}
function shapes(s: Spec): Shape[] {
  return [
    { kind: 'arc', cx: s.c, cy: s.c, R: s.R, from: s.arc[0], to: s.arc[1], sw: s.sw },
    { kind: 'tri', pts: triangle(pol(s.c, s.R, 90), 90, s.arrow.w, s.arrow.h), sj: s.arrow.sj },
    ...s.trail.map((t): Shape => { const [x, y] = pol(s.c, s.R, t.deg); return { kind: 'dot', x, y, r: t.r, op: t.op }; }),
  ];
}
/** Disques (x, y, rayon) qui couvrent une forme, épaisseur des traits comprise (échantillonnage). */
function samples(e: Shape): [number, number, number][] {
  if (e.kind === 'dot') return [[e.x, e.y, e.r]];
  const pts: [number, number, number][] = [];
  if (e.kind === 'arc') for (let d = e.from; d <= e.to; d += 0.5) pts.push([...pol(e.cx, e.R, d), e.sw / 2]);
  else for (let i = 0; i < 3; i++) {
    const p = e.pts[i]!, q = e.pts[(i + 1) % 3]!;
    for (let t = 0; t <= 1; t += 0.02) pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, e.sj / 2]);
  }
  return pts;
}
/** Boîte englobante [x1, y1, x2, y2]. */
function bbox(list: Shape[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y, r] of list.flatMap(samples)) {
    b[0] = Math.min(b[0], x - r); b[1] = Math.min(b[1], y - r); b[2] = Math.max(b[2], x + r); b[3] = Math.max(b[3], y + r);
  }
  return b;
}
/** Refuse une construction où deux éléments se touchent presque (min en unités de la boîte). */
function checkGaps(name: string, list: Shape[], min: number) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    let gap = Infinity;
    for (const p of samples(list[i]!)) for (const q of samples(list[j]!)) gap = Math.min(gap, Math.hypot(p[0] - q[0], p[1] - q[1]) - p[2] - q[2]);
    if (gap < min) throw new Error(`${name} : éléments ${i} et ${j} à ${gap.toFixed(1)} (minimum ${min})`);
  }
}

type Paint = { ring: string; arrow: string; trail: string; trailK: number };
function draw(list: Shape[], p: Paint): string {
  return list.map((e) => {
    if (e.kind === 'arc') {
      const [x1, y1] = pol(e.cx, e.R, e.from), [x2, y2] = pol(e.cx, e.R, e.to);
      return `<path d="M${f(x1)} ${f(y1)}A${e.R} ${e.R} 0 ${e.to - e.from > 180 ? 1 : 0} 1 ${f(x2)} ${f(y2)}" fill="none" stroke="${p.ring}" stroke-width="${f(e.sw)}" stroke-linecap="round"/>`;
    }
    if (e.kind === 'tri') {
      return `<path d="M${e.pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z" fill="${p.arrow}" stroke="${p.arrow}" stroke-width="${f(e.sj)}" stroke-linejoin="round"/>`;
    }
    return `<circle cx="${f(e.x)}" cy="${f(e.y)}" r="${f(e.r)}" fill="${p.trail}" fill-opacity="${f(e.op * p.trailK)}"/>`;
  }).join('');
}

// --- Icônes ----------------------------------------------------------------------------------------------------------

const icon = shapes(ICON);
checkGaps('icône', icon, 24); // ~3 px à 60 px
checkGaps('nom écrit', shapes(WORD), 8); // ~2 px à 48 px (marque de 26 px)
const ib = bbox(icon);
const centered = `<g transform="translate(${f(256 - (ib[0] + ib[2]) / 2)} ${f(256 - (ib[1] + ib[3]) / 2)})">`;
const THEMES = {
  sombre: { bg: ['#1F232C', '#0F1115'], paint: { ring: '#D3D8DF', arrow: '#F2B544', trail: '#6B7380', trailK: 1 } },
  ambre: { bg: ['#F7C663', '#EBA62C'], paint: { ring: '#1A1406', arrow: '#FFFFFF', trail: '#1A1406', trailK: 0.45 } },
} as const;

/** Icône carrée 512 ; radius = arrondi des coins en px (0 = pleine, pour les systèmes qui découpent eux-mêmes). */
function iconSvg(theme: keyof typeof THEMES, radius = 0): string {
  const t = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bg[0]}"/><stop offset="1" stop-color="${t.bg[1]}"/></linearGradient></defs>`
    + `<rect width="512" height="512" rx="${radius}" fill="url(#g)"/>${centered}${draw(icon, t.paint)}</g></svg>\n`;
}
const png = (svg: string, size: number) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

const full = iconSvg('sombre');
const rounded = iconSvg('sombre', 115); // 22,5 % : forme d'une icône d'appli pour les systèmes qui ne découpent pas
out('docs/logo/nexode-icone-sombre.svg', full);
out('docs/logo/nexode-icone-ambre.svg', iconSvg('ambre'));
out('docs/logo/nexode-marque.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${centered}${draw(icon, THEMES.sombre.paint)}</g></svg>\n`);
out('public/icons/icon.svg', rounded);
out('public/icons/icon-192.png', png(rounded, 192));
out('public/icons/icon-512.png', png(rounded, 512));
out('public/icons/maskable-512.png', png(full, 512)); // tout le dessin tient dans la zone sûre (rayon 205)
out('public/icons/apple-touch-icon.png', png(full, 180)); // iOS arrondit lui-même ; pas de transparence
// Badge des notifications Android : seule la transparence compte. Marque blanche, cadrée au plus près.
const pad = 8;
const side = Math.max(ib[2] - ib[0], ib[3] - ib[1]) + 2 * pad;
const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${f((ib[0] + ib[2] - side) / 2)} ${f((ib[1] + ib[3] - side) / 2)} ${f(side)} ${f(side)}">`
  + `${draw(icon, { ring: '#FFFFFF', arrow: '#FFFFFF', trail: '#FFFFFF', trailK: 1 })}</svg>`;
out('public/icons/badge-96.png', png(badge, 96));

// --- Nom écrit -------------------------------------------------------------------------------------------------------
// « nex » + marque à la place du o + « de », Space Grotesk 700, approche -0,02 em. Coordonnées en em × 1000, ligne de base y = 0.
// La marque occupe 0,54 em de haut, 0,02 em sous la ligne de base, 0,02 em après le x ; ce qui dépasse à droite (la flèche)
// est compensé avant le d, plus 0,03 em.

const woff = readFileSync(new URL('tools/fonts/space-grotesk-latin-700-normal.woff', root));
const font = opentype.parse(woff.buffer.slice(woff.byteOffset, woff.byteOffset + woff.byteLength) as ArrayBuffer);
const EM = 1000, TRACK = -0.02 * EM, scale = EM / font.unitsPerEm;

const frame: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
const grow = (x1: number, y1: number, x2: number, y2: number) => {
  frame[0] = Math.min(frame[0], x1); frame[1] = Math.min(frame[1], y1); frame[2] = Math.max(frame[2], x2); frame[3] = Math.max(frame[3], y2);
};
function text(str: string, x0: number): { d: string; x: number } {
  let x = x0, d = '';
  const glyphs = [...str].map((c) => font.charToGlyph(c));
  glyphs.forEach((g, i) => {
    const path = g.getPath(x, 0, EM);
    const b = path.getBoundingBox();
    grow(b.x1, b.y1, b.x2, b.y2);
    d += path.toPathData(1);
    const next = glyphs[i + 1];
    x += (g.advanceWidth ?? 0) * scale + TRACK + (next ? font.getKerningValue(g, next) * scale : 0);
  });
  return { d, x };
}
const nex = text('nex', 0);
const markH = 0.54 * EM, mk = markH / 100;
const markX = nex.x + 0.02 * EM, markY = 0.02 * EM - markH;
const word = shapes(WORD);
const wb = bbox(word);
const de = text('de', markX + markH + Math.max(0, wb[2] - 100) * mk + 0.03 * EM);
const toWord = (x: number, y: number): [number, number] => [markX + x * mk, markY + y * mk];

// Marque passée dans le repère du nom (les arcs restent des arcs : changement d'échelle uniforme).
const markParts = word.map((e) => {
  if (e.kind === 'arc') {
    const [x1, y1] = toWord(...pol(e.cx, e.R, e.from)), [x2, y2] = toWord(...pol(e.cx, e.R, e.to)), R = e.R * mk;
    return { kind: 'ring', d: `M${f(x1)} ${f(y1)}A${f(R)} ${f(R)} 0 1 1 ${f(x2)} ${f(y2)}`, sw: f(e.sw * mk) };
  }
  if (e.kind === 'tri') return { kind: 'arrow', d: `M${e.pts.map(([x, y]) => toWord(x, y).map(f).join(' ')).join('L')}Z`, sw: f(e.sj * mk) };
  const [cx, cy] = toWord(e.x, e.y);
  return { kind: 'trail', cx: f(cx), cy: f(cy), r: f(e.r * mk), op: e.op };
});

// Cadre : lettres et marque (épaisseur des traits comprise), arrondi au dixième vers l'extérieur.
grow(...toWord(wb[0], wb[1]), ...toWord(wb[2], wb[3]));
const [x1, y1] = [Math.floor(frame[0] * 10) / 10, Math.floor(frame[1] * 10) / 10];
const viewBox = `${x1} ${y1} ${f(Math.ceil(frame[2] * 10) / 10 - x1)} ${f(Math.ceil(frame[3] * 10) / 10 - y1)}`;

out('public/app/brand.js', `// Généré par tools/brand.ts (docs/charte.md) : ne pas modifier à la main.
// Nom écrit « nexode » en tracés : lettres Space Grotesk 700, marque à la place du o. Unités : em × 1000, ligne de base y = 0.
export const WORDMARK = ${JSON.stringify({ viewBox, letters: nex.d + de.d, parts: markParts }, null, 2)};
`);

const wordSvg = (fg: string, accent: string, dot: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" height="120">`
  + `<path d="${nex.d}${de.d}" fill="${fg}"/>` + markParts.map((p) => p.kind === 'ring'
    ? `<path d="${p.d}" fill="none" stroke="${fg}" stroke-width="${p.sw}" stroke-linecap="round"/>`
    : p.kind === 'arrow' ? `<path d="${p.d}" fill="${accent}" stroke="${accent}" stroke-width="${p.sw}" stroke-linejoin="round"/>`
    : `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${dot}" fill-opacity="${p.op}"/>`).join('') + '</svg>\n';
out('docs/logo/nexode-nom-sombre.svg', wordSvg('#ECEEF1', '#F2B544', '#6B7380'));
out('docs/logo/nexode-nom-clair.svg', wordSvg('#15181D', '#936008', '#808894'));
