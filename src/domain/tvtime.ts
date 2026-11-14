// Lecture de l'export RGPD de TV Time (tracking-prod-records-v2.csv). Pur, sans I/O.
// Lignes utiles : watch-episode-* et rewatch-episode-* (visionnages), user-series-* (état de suivi).
// s_id / ep_id = identifiants TheTVDB ; created_at = instant du visionnage, en UTC.

export type TvTimeWatch = {
  tvdbShowId: number;
  tvdbEpisodeId: number | null;
  showName: string;
  season: number;
  number: number;
  watchedAt: string;           // ISO 8601 UTC
};

export type TvTimeSeries = {
  tvdbShowId: number;
  name: string;
  followed: boolean;
  shelved: boolean;            // archivée ou « pour plus tard » → De côté
  addedAt: string | null;      // ISO 8601 UTC
};

export type TvTimeExport = { watches: TvTimeWatch[]; series: TvTimeSeries[] };

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

const int = (s: string | undefined): number | null => (s && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

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

export class TvTimeFormatError extends Error {}

export function parseTvTime(text: string): TvTimeExport {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) throw new TvTimeFormatError('fichier vide');
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new TvTimeFormatError(`colonne « ${name} » absente : ce n'est pas tracking-prod-records-v2.csv`);
    return i;
  };
  const C = {
    key: col('key'), sId: col('s_id'), epId: col('ep_id'), sNo: col('s_no'), epNo: col('ep_no'), createdAt: col('created_at'),
    followed: col('is_followed'), followedAt: col('followed_at'), archived: col('is_archived'), forLater: col('is_for_later'),
    special: col('is_special'), name: col('series_name'), seasonNumber: col('season_number'), episodeNumber: col('episode_number'),
  };

  // Un épisode vu plusieurs fois (revisionnage) : on garde le premier visionnage.
  const watches = new Map<string, TvTimeWatch>();
  const series = new Map<number, TvTimeSeries>();
  for (const r of rows) {
    const key = r[C.key] ?? '';
    const tvdbShowId = int(r[C.sId]);
    if (tvdbShowId === null) continue;
    const name = (r[C.name] ?? '').trim();
    if (key.startsWith('watch-episode-') || key.startsWith('rewatch-episode-')) {
      const season = int(r[C.seasonNumber]) ?? int(r[C.sNo]);
      const number = int(r[C.episodeNumber]) ?? int(r[C.epNo]);
      const watchedAt = utc(r[C.createdAt]);
      if (season === null || number === null || watchedAt === null) continue;
      if (season === 0 || r[C.special] === 'true') continue;   // épisodes spéciaux : non importés (saison 0 absente du catalogue)
      const k = `${tvdbShowId}:${season}:${number}`;
      const prev = watches.get(k);
      if (!prev || watchedAt < prev.watchedAt) watches.set(k, { tvdbShowId, tvdbEpisodeId: int(r[C.epId]), showName: name, season, number, watchedAt });
    } else if (key.startsWith('user-series-')) {
      series.set(tvdbShowId, {
        tvdbShowId,
        name,
        followed: r[C.followed] === 'true',
        shelved: r[C.archived] === 'true' || r[C.forLater] === 'true',
        addedAt: fromMicros(r[C.followedAt]) ?? utc(r[C.createdAt]),
      });
    }
  }
  return {
    watches: [...watches.values()].sort((a, b) => (a.watchedAt < b.watchedAt ? -1 : a.watchedAt > b.watchedAt ? 1 : 0)),
    series: [...series.values()],
  };
}
