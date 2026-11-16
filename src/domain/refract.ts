// Sauvegarde Refract (« Vos données › Télécharger une copie » : refract-backup-<version>-<date>.zip). Pur, sans I/O.
// Lu dans data/, la copie qui fait foi (readable/ n'en est qu'un rendu CSV) : manifest.json (version du format),
// library.jsonl (séries et statut), episodes.jsonl (épisodes vus, date locale + fuseau). Ids TMDB partout.
// imported = false : épisode coché dans Refract même, donc seul ; true : venu d'une autre appli, provenance déduite
// de la seconde partagée (date sans heure = midi : un jour à un seul épisode compte comme seul).
// Films, notes, journal et publications ignorés.
import { type ImportData, type ImportSeries, type ImportWatch, ImportFormatError, aloneInItsSecond, wallTimeToUtc } from './imports.ts';
import { readZip } from './zip.ts';

export const REFRACT_FILES = ['manifest.json', 'data/library.jsonl', 'data/episodes.jsonl'] as const;
const FORMAT_MAJOR = '4';
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const SHELVED = new Set(['dropped', 'on_hold', 'planned']);   // abandonnée, en pause, à voir → De côté

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => x !== null && typeof x === 'object' && !Array.isArray(x);
const posInt = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const iso = (x: unknown): string | null => {
  const t = typeof x === 'string' ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function jsonl(text: string, file: string): Rec[] {
  return text.split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    let v: unknown;
    try { v = JSON.parse(line); } catch { throw new ImportFormatError(`${file}, ligne ${i + 1} : JSON invalide`); }
    if (!isRec(v)) throw new ImportFormatError(`${file}, ligne ${i + 1} : objet attendu`);
    return [v];
  });
}

// Série d'un enregistrement (champ item) ; null si ce n'est pas une série TMDB.
function showOf(r: Rec) {
  const item = isRec(r.item) ? r.item : null;
  const tmdbId = posInt(item?.tmdbId);
  if (!item || item.mediaType !== 'tv' || tmdbId === null) return null;
  const title = str(item.displayTitle) ?? str(item.englishTitle) ?? str(item.title) ?? `TMDB ${tmdbId}`;
  return { tmdbId, tvdbId: posInt(item.tvdbId), title, year: posInt(item.year) };
}

// Date du jour seule ('2023-02-05') : midi heure locale, pour que le jour ne change pas selon le fuseau d'affichage.
// Sans date exploitable : date d'enregistrement dans Refract (moment où l'épisode y a été coché).
function watchedAt(r: Rec, defaultTz: string): string | null {
  const w = isRec(r.watchedAt) ? r.watchedAt : null;
  const local = str(w?.local);
  if (local) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(local)) {
      try { return wallTimeToUtc(`${local} 12:00:00`, str(w?.tz) ?? defaultTz); } catch { /* fuseau inconnu */ }
    } else {
      const at = iso(local);
      if (at) return at;
    }
  }
  return iso(r.createdAt);
}

// Fichiers de l'archive (nom → texte) → format commun.
export function parseRefract(files: ReadonlyMap<string, string>): ImportData {
  const manifestText = files.get('manifest.json');
  if (manifestText === undefined) throw new ImportFormatError('archive non reconnue');
  let manifest: unknown;
  try { manifest = JSON.parse(manifestText); } catch { throw new ImportFormatError('manifest.json invalide'); }
  if (!isRec(manifest) || !String(manifest.generator ?? '').startsWith('refract')) throw new ImportFormatError('archive non reconnue');
  const version = String(manifest.formatVersion ?? '');
  if (version.split('.')[0] !== FORMAT_MAJOR) throw new ImportFormatError(`sauvegarde Refract au format ${version || 'inconnu'}, non prise en charge`);
  const defaultTz = (isRec(manifest.account) && str(manifest.account.timezone)) || 'UTC';
  const library = files.get('data/library.jsonl');
  const episodes = files.get('data/episodes.jsonl');
  if (library === undefined || episodes === undefined) throw new ImportFormatError('sauvegarde Refract incomplète');

  const series: ImportSeries[] = [];
  for (const r of jsonl(library, 'library.jsonl')) {
    const show = showOf(r);
    if (show) series.push({ show, followed: true, shelved: SHELVED.has(String(r.status)), addedAt: iso(r.createdAt) });
  }

  // Un enregistrement par épisode en principe ; en cas de doublon, le plus ancien visionnage.
  const watches = new Map<string, ImportWatch>();
  const unknown = new Set<string>();   // clés dont la provenance est à déduire
  for (const r of jsonl(episodes, 'episodes.jsonl')) {
    const show = showOf(r);
    const season = posInt(r.seasonNumber);
    const number = posInt(r.episodeNumber);
    if (!show || season === null || number === null || r.watched !== true || r.isSpecial === true) continue;
    const at = watchedAt(r, defaultTz);
    if (!at) continue;
    const k = `${show.tmdbId}:${season}:${number}`;
    const prev = watches.get(k);
    if (!prev || at < prev.watchedAt) {
      watches.set(k, { show, tvdbEpisodeId: null, season, number, watchedAt: at, single: r.imported === false });
      if (r.imported === false) unknown.delete(k);
      else unknown.add(k);
    }
  }
  const alone = aloneInItsSecond([...watches.values()]);
  return { watches: [...watches].map(([k, w]) => (unknown.has(k) ? { ...w, single: alone(w.watchedAt) } : w)), series };
}

export function readRefractBackup(zip: Uint8Array): ImportData {
  const entries = readZip(zip, REFRACT_FILES, MAX_ENTRY_BYTES);
  const utf8 = new TextDecoder('utf-8', { fatal: false });
  return parseRefract(new Map([...entries].map(([name, data]) => [name, utf8.decode(data)])));
}
