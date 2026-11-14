import { localDate } from '../domain/dates.ts';
import { type ShelfReason, buildShelf, buildToWatch, buildUpcoming } from '../domain/lists.ts';
import { type EpisodeRow, type HistoryCursor, type ShowRow, getHistory, getSeasonCounts, getUserShows } from '../infra/repos.ts';
import { type Ctx, InvalidInputError, today } from './context.ts';
import { type LoadedShow, episodeView, loadShows, seriesRow, showRef } from './state.ts';

function followedShows(ctx: Ctx): LoadedShow[] {
  return [...loadShows(ctx, getUserShows(ctx.db, ctx.user.id).map((f) => f.showId)).values()];
}

// Écran « En cours » : À regarder + À venir.
export function timeline(ctx: Ctx) {
  const entries = followedShows(ctx);
  return {
    today: today(ctx),
    toWatch: buildToWatch(entries).map((x) =>
      ({ show: showRef(x.show), next: episodeView(x.next), upNext: x.upNext.map(episodeView), remaining: x.remaining })),
    upcoming: buildUpcoming(entries).map((x) => ({ show: showRef(x.show), episode: episodeView(x.episode), more: x.more })),
  };
}

// Écran « De côté ».
export function shelf(ctx: Ctx) {
  const { notStarted, abandoned } = buildShelf(followedShows(ctx));
  const card = (c: { show: ShowRow; reason: ShelfReason; next: EpisodeRow | null; remaining: number }) =>
    ({ show: showRef(c.show), reason: c.reason, next: c.next ? episodeView(c.next) : null, remaining: c.remaining });
  return { notStarted: notStarted.map(card), abandoned: abandoned.map(card) };
}

// « Mes séries » : séries suivies et de côté, par nom.
export function myShows(ctx: Ctx) {
  const entries = followedShows(ctx);
  const counts = getSeasonCounts(ctx.db, entries.map((s) => s.show.id));
  return entries
    .sort((a, b) => a.show.name.localeCompare(b.show.name, 'fr') || a.show.id - b.show.id)
    .map((s) => seriesRow(s, counts.get(s.show.id) ?? 0));
}

// ---------- historique ----------

export const HISTORY_PAGE = 40;

export function encodeCursor(c: HistoryCursor): string {
  return Buffer.from(`${c.watchedAt}|${c.episodeId}`).toString('base64url');
}

export function decodeCursor(raw: string): HistoryCursor {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([1-9]\d*)$/.exec(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!m) throw new InvalidInputError('before');
  return { watchedAt: m[1] as string, episodeId: Number(m[2]) };
}

// Épisodes vus, toutes séries (même non suivies), du plus récent au plus ancien. next = curseur de la page suivante.
// Épisode retiré chez TMDB : retired = true (numéro d'origine conservé).
export function history(ctx: Ctx, before: HistoryCursor | null, limit = HISTORY_PAGE) {
  const rows = getHistory(ctx.db, ctx.user.id, before, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      episodeId: r.episodeId,
      watchedAt: r.watchedAt,
      watchedDay: localDate(r.watchedAt, ctx.user.timezone),
      show: { id: r.showId, name: r.showName, posterPath: r.posterPath },
      season: r.season,
      number: r.number,
      retired: r.retired === 1,
      title: r.title,
      titleIsVo: r.titleIsVo === 1,
    })),
    next: rows.length > limit && last ? encodeCursor({ watchedAt: last.watchedAt, episodeId: last.episodeId }) : null,
  };
}
