import webpush from 'web-push';
import type { Vapid } from '../config.ts';
import type { Push, PushResult } from '../ports.ts';

// Envoi Web Push (chiffrement aes128gcm + en-têtes VAPID par la lib web-push).
// TTL : un message non remis (téléphone éteint) est abandonné par le service push au bout de 12 h.
const TTL_S = 12 * 3600;
const TIMEOUT_MS = 10_000;

export function createPush(vapid: Vapid, warn: (message: string) => void = console.warn): Push {
  return {
    publicKey: vapid.publicKey,
    async send(sub, payload): Promise<PushResult> {
      const host = new URL(sub.endpoint).host;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { vapidDetails: vapid, TTL: TTL_S, urgency: 'normal', timeout: TIMEOUT_MS },
        );
        return 'sent';
      } catch (err) {
        const status = (err as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410) return 'gone';
        const body = String((err as { body?: unknown }).body ?? '').slice(0, 200);
        warn(`push vers ${host} en échec : ${typeof status === 'number' ? `HTTP ${status} ${body}` : (err as Error).message}`);
        return 'failed';
      }
    },
  };
}
