import { transaction } from '../db/index.ts';
import type { Relation } from '../domain/series.ts';
import { deleteUserShow, insertUserShow, resumeUserShow, setUserShowState } from '../infra/repos.ts';
import { type Ctx, nowIso } from './context.ts';
import { type ShowState, ensureShowCached, loadShow, showState } from './state.ts';

// Change la relation à une série. Ne touche jamais aux épisodes vus. Même relation = rien ne change.
export async function setRelation(ctx: Ctx, showId: number, to: Relation): Promise<ShowState> {
  await ensureShowCached(ctx, showId);
  const { db, user } = ctx;
  const now = nowIso(ctx);
  transaction(db, () => {
    const from = loadShow(ctx, showId).relation;
    if (from === to) return;
    if (to === 'none') deleteUserShow(db, user.id, showId);
    else if (to === 'on') {
      if (from === 'none') insertUserShow(db, user.id, showId, 'followed', now);
      else resumeUserShow(db, user.id, showId, now);                  // reprise : compteur d'inactivité remis à zéro
    } else if (from === 'none') insertUserShow(db, user.id, showId, 'shelved', now);   // « à voir plus tard »
    else setUserShowState(db, user.id, showId, 'shelved');
  });
  return showState(ctx, loadShow(ctx, showId));
}
