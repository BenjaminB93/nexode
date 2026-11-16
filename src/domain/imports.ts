// Imports depuis d'autres applis : format commun, détection du format, outils de lecture. Pur, sans I/O.

// Série telle que l'export la désigne : id TMDB (Refract), id TheTVDB (TV Time, Refract), sinon titre et éventuelle année (BetaSeries).
export type ShowRef = { tmdbId: number | null; tvdbId: number | null; title: string; year: number | null };
// single : la source atteste que l'épisode a été marqué seul (son heure date un vrai visionnage), voir migration 005.
export type ImportWatch = { show: ShowRef; tvdbEpisodeId: number | null; season: number; number: number; watchedAt: string; single: boolean };
export type ImportSeries = { show: ShowRef; followed: boolean; shelved: boolean; addedAt: string | null };
export type ImportData = { watches: ImportWatch[]; series: ImportSeries[] };

export type ImportFormat = 'tvtime' | 'betaseries-episodes' | 'betaseries-series' | 'refract';
export const FORMAT_LABELS: Record<ImportFormat, string> = {
  tvtime: 'TV Time',
  'betaseries-episodes': 'BetaSeries (épisodes)',
  'betaseries-series': 'BetaSeries (séries)',
  refract: 'Refract',
};

export class ImportFormatError extends Error {}

// CSV RFC 4180 : champs entre guillemets, guillemets doublés, retours à la ligne dans un champ.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// En-tête → accès aux colonnes par nom. Colonne absente = mauvais fichier.
export function columns<K extends string>(header: string[], names: Record<K, string>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const [k, name] of Object.entries(names) as [K, string][]) {
    const i = header.indexOf(name);
    if (i < 0) throw new ImportFormatError(`colonne « ${name} » absente`);
    out[k] = i;
  }
  return out;
}

export const int = (s: string | undefined): number | null => (s && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

// Titre comparable : sans accents, casse ni ponctuation (« Star Trek : Strange New Worlds » = « Star Trek: Strange New Worlds »).
export function normTitle(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');
}

// « Once Upon a Time (2011) » → titre + année.
export function splitYear(title: string): { title: string; year: number | null } {
  const m = /^(.*\S)\s*\((\d{4})\)$/.exec(title.trim());
  return m ? { title: m[1] as string, year: Number(m[2]) } : { title: title.trim(), year: null };
}

export function showKey(ref: ShowRef): string {
  return ref.tmdbId !== null ? `tmdb:${ref.tmdbId}` : ref.tvdbId !== null ? `tvdb:${ref.tvdbId}` : `titre:${normTitle(ref.title)}:${ref.year ?? ''}`;
}

// Heure locale 'YYYY-MM-DD HH:MM:SS' dans un fuseau IANA → instant ISO UTC (heure d'été comprise).
export function wallTimeToUtc(local: string, timezone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t));
    const g = (type: string) => Number(p.find((x) => x.type === type)?.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t).toISOString();
}
