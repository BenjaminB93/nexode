// Service worker : notifications push uniquement. Aucun cache : l'appli reste servie par le réseau.
// Contenu reçu (src/domain/notifications.ts) : { title, body, tag, open: { show, name, season, number, ep } | null }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { /* contenu illisible : notification générique */ }
  event.waitUntil(self.registration.showNotification(p.title || 'Nouvel épisode', {
    body: p.body || '',
    tag: p.tag,
    lang: 'fr',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { open: p.open || null },
  }));
});

// Toucher : fiche de l'épisode. Appli déjà ouverte → elle est mise au premier plan et reçoit la cible ; sinon ouverture.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const open = event.notification.data && event.notification.data.open;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const win = await wins[0].focus();
      if (open) (win || wins[0]).postMessage({ type: 'open-episode', open });
      return;
    }
    const q = open ? '/?' + new URLSearchParams({
      show: open.show, name: open.name, season: open.season, number: open.number, ep: open.ep,
    }) : '/';
    await self.clients.openWindow(q);
  })());
});

// Abonnement renouvelé par le navigateur (Firefox) : réenregistré auprès du serveur. Les autres le sont à l'ouverture de l'appli.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('/api/push/key', { credentials: 'same-origin' });
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
    });
    await fetch('/api/push/subscription', {
      method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()),
    });
  })());
});
