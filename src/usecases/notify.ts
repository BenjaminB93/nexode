import type { Db } from '../db/index.ts';
import { localDate, todayIn } from '../domain/dates.ts';
import { type NotifEpisode, isDue, localHour, notificationFor } from '../domain/notifications.ts';
import {
  type NotifEpisodeRow, deleteNotificationsSentBefore, deletePushEndpoint, getNotifiableEpisodes, insertNotificationSent,
  listPushSubscriptions, listPushUsers,
} from '../infra/repos.ts';
import type { Push } from '../ports.ts';
import { loadShows } from './state.ts';

// Tâche horaire : pour chaque compte dont l'heure d'envoi est passée (dans son fuseau), une notification par série suivie
// hors « De côté » ayant un épisode non vu qui sort aujourd'hui. Envoi tracé (notifications_sent) : jamais deux fois
// la même série le même jour, et une heure manquée (redémarrage, échec réseau) est rattrapée à l'heure suivante.

export type NotifyReport = { users: number; notifications: number; sent: number; gone: number; failed: number; aborted: boolean };

export type NotifyDeps = { db: Db; push: Push; now?: () => Date; signal?: AbortSignal };

const SENT_KEEP_DAYS = 3;

export async function sendDueNotifications({ db, push, now = () => new Date(), signal }: NotifyDeps): Promise<NotifyReport> {
  const report: NotifyReport = { users: 0, notifications: 0, sent: 0, gone: 0, failed: 0, aborted: false };
  const start = now();
  deleteNotificationsSentBefore(db, localDate(new Date(start.getTime() - SENT_KEEP_DAYS * 86_400_000), 'UTC'));
  for (const user of listPushUsers(db)) {
    if (signal?.aborted) {
      report.aborted = true;
      break;
    }
    if (!isDue(localHour(start, user.timezone), user.notifHour)) continue;
    const day = todayIn(user.timezone, start);
    const byShow = new Map<number, NotifEpisodeRow[]>();
    for (const e of getNotifiableEpisodes(db, user.id, day)) byShow.set(e.showId, [...(byShow.get(e.showId) ?? []), e]);
    if (!byShow.size) continue;
    const loaded = loadShows({ db, now: start, user }, [...byShow.keys()]);
    let subs = listPushSubscriptions(db, user.id);
    let notified = false;
    for (const [showId, episodes] of byShow) {
      const s = loaded.get(showId);
      if (!s || s.relation !== 'on' || !subs.length) continue;
      const payload = notificationFor({ id: showId, name: s.show.name }, episodes as NotifEpisode[]);
      let delivered = false;
      const gone = new Set<string>();
      for (const sub of subs) {
        const r = await push.send(sub, payload);
        report[r]++;
        if (r === 'sent') delivered = true;
        if (r === 'gone') {
          deletePushEndpoint(db, sub.endpoint);
          gone.add(sub.endpoint);
        }
      }
      subs = subs.filter((sub) => !gone.has(sub.endpoint));
      if (delivered) {
        insertNotificationSent(db, user.id, showId, day, now().toISOString());
        report.notifications++;
        notified = true;
      }
    }
    if (notified) report.users++;
  }
  return report;
}

export function describeNotify(r: NotifyReport): string {
  return `${r.notifications} notifications pour ${r.users} comptes (${r.sent} envois, ${r.gone} abonnements supprimés, ${r.failed} échecs)`
    + (r.aborted ? ', interrompu' : '');
}
