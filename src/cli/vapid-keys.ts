// Génère une paire de clés VAPID (identité du serveur auprès des services push), à copier dans .env.
// Une seule fois : changer de clés invalide tous les abonnements (chaque appareil devra réactiver les notifications).
// Usage : node src/cli/vapid-keys.ts
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
