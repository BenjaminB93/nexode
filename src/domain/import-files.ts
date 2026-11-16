// Détection du format et lecture de plusieurs fichiers d'export en un seul jeu de données.
import { parseBetaSeriesEpisodes, parseBetaSeriesSeries } from './betaseries.ts';
import { type ImportData, type ImportFormat, ImportFormatError, parseCsv } from './imports.ts';
import { readRefractBackup } from './refract.ts';
import { parseTvTime } from './tvtime.ts';
import { isZip } from './zip.ts';

export function detectFormat(text: string): ImportFormat | null {
  const header = parseCsv(text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '')[0] ?? [];
  if (header.includes('s_id') && header.includes('series_name')) return 'tvtime';
  if (header.join(',') === 'id,show,episode,title,date,note') return 'betaseries-episodes';
  if (header.includes('archive') && header.includes('remaining') && header.includes('title')) return 'betaseries-series';
  return null;
}

// Fichier CSV lu en texte, ou contenu brut (archive ZIP Refract, ou CSV encore à décoder en UTF-8).
export type ImportFile = { name: string; text: string } | { name: string; bytes: Uint8Array };
export type ParsedFiles = { data: ImportData; files: { name: string; format: ImportFormat | null; error?: string }[] };

function parseOne(f: ImportFile): { format: ImportFormat; part: ImportData } {
  if ('bytes' in f && isZip(f.bytes)) return { format: 'refract', part: readRefractBackup(f.bytes) };
  const text = ('bytes' in f ? new TextDecoder().decode(f.bytes) : f.text).replace(/^﻿/, '');
  const format = detectFormat(text);
  const part = format === 'tvtime' ? parseTvTime(text)
    : format === 'betaseries-episodes' ? parseBetaSeriesEpisodes(text)
    : format === 'betaseries-series' ? parseBetaSeriesSeries(text)
    : null;
  if (!format || !part) throw new ImportFormatError('format non reconnu');
  return { format, part };
}

// Lit plusieurs fichiers, de formats éventuellement différents, en un seul jeu de données.
export function parseImportFiles(files: readonly ImportFile[]): ParsedFiles {
  const data: ImportData = { watches: [], series: [] };
  const out: ParsedFiles['files'] = [];
  for (const f of files) {
    try {
      const { format, part } = parseOne(f);
      data.watches.push(...part.watches);
      data.series.push(...part.series);
      out.push({ name: f.name, format });
    } catch (err) {
      out.push({ name: f.name, format: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { data, files: out };
}
