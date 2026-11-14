import { isPushEndpoint, isPushKeys } from '../domain/notifications.ts';
import { deletePushEndpoint, deleteUserPushSubscription, getPushSubscription, upsertPushSubscription } from '../infra/repos.ts';
import type { Push } from '../ports.ts';
import { type Ctx, AppError, InvalidInputError, NotFoundError, nowIso } from './context.ts';

// Abonnements push d'un appareil. Un abonnement suit la session qui l'a enregistré (déconnexion = plus de notifications).

export type DeviceSubscription = { endpoint: string; p256dh: string; auth: string };

export class PushUnavailableError extends AppError {
  constructor() { super('push_unavailable', 'notifications non configurées (clés VAPID absentes)'); }
}

export function requirePush(push: Push | undefined): Push {
  if (!push) throw new PushUnavailableError();
  return push;
}

// Idempotent ; un endpoint déjà enregistré par un autre compte (même appareil) passe au compte courant.
export function subscribe(ctx: Ctx, sessionHash: string, sub: DeviceSubscription): void {
  if (!isPushEndpoint(sub.endpoint)) throw new InvalidInputError('endpoint');
  if (!isPushKeys(sub.p256dh, sub.auth)) throw new InvalidInputError('keys');
  upsertPushSubscription(ctx.db, { ...sub, userId: ctx.user.id, sessionHash, nowIso: nowIso(ctx) });
}

// Idempotent : un endpoint inconnu ou d'un autre compte ne change rien.
export function unsubscribe(ctx: Ctx, endpoint: string): void {
  deleteUserPushSubscription(ctx.db, ctx.user.id, endpoint);
}

// Notification de test vers un appareil du compte. gone : l'abonnement est supprimé (le client se réabonne).
export async function sendTest(ctx: Ctx, push: Push, endpoint: string): Promise<{ result: 'sent' | 'gone' | 'failed' }> {
  const sub = getPushSubscription(ctx.db, ctx.user.id, endpoint);
  if (!sub) throw new NotFoundError('abonnement');
  const result = await push.send(sub, { title: 'Notifications activées', body: 'Elles arriveront ici à l\'heure choisie.', tag: 'test', open: null });
  if (result === 'gone') deletePushEndpoint(ctx.db, endpoint);
  return { result };
}
