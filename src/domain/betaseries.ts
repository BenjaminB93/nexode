// Exports CSV de BetaSeries. Pur, sans I/O. Aucun identifiant externe : les séries sont désignées par leur titre,
// avec l'année entre parenthèses quand BetaSeries en met une (« Once Upon a Time (2011) »).
// episodes-<compte>.csv : id,show,episode,title,date,note — date = heure de Paris.
// series-<compte>.csv : id,title,archive,episode,remaining,status,tags,note — archive = 1 → De côté.
import { type ImportData, type ImportWatch, ImportFormatError, columns, int, parseCsv, splitYear, wallTimeToUtc } from './imports.ts';

const TIMEZONE = 'Europe/Paris';

export function parseBetaSeriesEpisodes(text: string): ImportData {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new ImportFormatError('fichier vide');
  const C = columns(header, { show: 'show', episode: 'episode', date: 'date' });
  const watches = new Map<string, ImportWatch>();
  for (const r of rows) {
    const code = /^S(\d+)E(\d+)$/i.exec((r[C.episode] ?? '').trim());
    const watchedAt = wallTimeToUtc(r[C.date] ?? '', TIMEZONE);
    if (!code || !watchedAt) continue;
    const season = Number(code[1]), number = Number(code[2]);
    if (season === 0 || number === 0) continue;
    const show = { tvdbId: null, ...splitYear(r[C.show] ?? '') };
    if (!show.title) continue;
    const k = `${show.title}|${show.year}|${season}|${number}`;
    const prev = watches.get(k);
    if (!prev || watchedAt < prev.watchedAt) watches.set(k, { show, tvdbEpisodeId: null, season, number, watchedAt });
  }
  return { watches: [...watches.values()], series: [] };
}

export function parseBetaSeriesSeries(text: string): ImportData {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new ImportFormatError('fichier vide');
  const C = columns(header, { title: 'title', archive: 'archive' });
  const series: ImportData['series'] = [];
  for (const r of rows) {
    const show = { tvdbId: null, ...splitYear(r[C.title] ?? '') };
    if (!show.title) continue;
    series.push({ show, followed: true, shelved: int(r[C.archive]) === 1, addedAt: null });
  }
  return { watches: [], series };
}
