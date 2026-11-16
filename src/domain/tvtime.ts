// Export RGPD de TV Time (tracking-prod-records-v2.csv). Pur, sans I/O.
// Lignes utiles : watch-episode-* et rewatch-episode-* (visionnages), user-series-* (état de suivi).
// s_id / ep_id = identifiants TheTVDB ; created_at = instant du visionnage, en UTC.
import { type ImportData, type ImportWatch, ImportFormatError, columns, int, parseCsv } from './imports.ts';

// '2022-11-17 19:11:15' (UTC) → ISO.
function utc(s: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec((s ?? '').trim());
  return m ? `${m[1]}T${m[2]}.000Z` : null;
}

// followed_at : microsecondes depuis l'époque Unix.
function fromMicros(s: string | undefined): string | null {
  const n = int(s);
  return n === null ? null : new Date(Math.floor(n / 1000)).toISOString();
}

export function parseTvTime(text: string): ImportData {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) throw new ImportFormatError('fichier vide');
  const C = columns(header, {
    key: 'key', sId: 's_id', epId: 'ep_id', sNo: 's_no', epNo: 'ep_no', createdAt: 'created_at',
    followed: 'is_followed', followedAt: 'followed_at', archived: 'is_archived', forLater: 'is_for_later',
    special: 'is_special', name: 'series_name', seasonNumber: 'season_number', episodeNumber: 'episode_number',
  });

  // Un épisode vu plusieurs fois (revisionnage) : on garde le premier visionnage.
  const watches = new Map<string, ImportWatch>();
  const series: ImportData['series'] = [];
  for (const r of rows) {
    const key = r[C.key] ?? '';
    const tvdbId = int(r[C.sId]);
    if (tvdbId === null) continue;
    const show = { tmdbId: null, tvdbId, title: (r[C.name] ?? '').trim(), year: null };
    if (key.startsWith('watch-episode-') || key.startsWith('rewatch-episode-')) {
      const season = int(r[C.seasonNumber]) ?? int(r[C.sNo]);
      const number = int(r[C.episodeNumber]) ?? int(r[C.epNo]);
      const watchedAt = utc(r[C.createdAt]);
      if (season === null || number === null || watchedAt === null) continue;
      if (season === 0 || number === 0 || r[C.special] === 'true') continue;   // spéciaux : saison 0 absente du catalogue
      const k = `${tvdbId}:${season}:${number}`;
      const prev = watches.get(k);
      if (!prev || watchedAt < prev.watchedAt) watches.set(k, { show, tvdbEpisodeId: int(r[C.epId]), season, number, watchedAt });
    } else if (key.startsWith('user-series-')) {
      series.push({
        show,
        followed: r[C.followed] === 'true',
        shelved: r[C.archived] === 'true' || r[C.forLater] === 'true',
        addedAt: fromMicros(r[C.followedAt]) ?? utc(r[C.createdAt]),
      });
    }
  }
  return { watches: [...watches.values()], series };
}
