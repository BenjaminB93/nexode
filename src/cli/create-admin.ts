// Crée le compte admin (sans mot de passe utilisable) s'il n'existe pas, puis affiche un lien de réinitialisation (24 h)
// pour choisir le mot de passe dans l'appli. Relancé sur un admin existant : nouveau lien (mot de passe oublié).
// Usage : node --env-file-if-exists=.env src/cli/create-admin.ts <nom>
import { loadConfig } from '../config.ts';
import { openDb, transaction } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { normalizeUsername, usernameKey } from '../domain/accounts.ts';
import { getAccountByKey, insertUser } from '../infra/repos.ts';
import { createResetToken } from '../usecases/admin.ts';

const [nameArg, ...rest] = process.argv.slice(2);
const name = nameArg === undefined || rest.length ? null : normalizeUsername(nameArg);
if (name === null) {
  console.error('Usage : node --env-file-if-exists=.env src/cli/create-admin.ts <nom>');
  console.error('Nom : 3 à 24 caractères, lettres, chiffres, « _ », « - », « . ».');
  process.exit(2);
}

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);
const now = new Date();
const key = usernameKey(name);

const existing = getAccountByKey(db, key);
if (existing && existing.role !== 'admin') {
  console.error(`Le compte « ${existing.username} » existe déjà et n'est pas admin : rien n'est modifié.`);
  db.close();
  process.exit(1);
}
const userId = existing?.id ?? transaction(db, () => insertUser(db, {
  username: name, usernameKey: key, pwHash: '!', role: 'admin', invitedBy: null, createdAt: now.toISOString(),
}));
const { token, expiresAt } = createResetToken({ db, now }, userId);
db.close();

console.log(existing ? `Compte admin « ${existing.username} » déjà présent.` : `Compte admin « ${name} » créé.`);
console.log(`Choisir le mot de passe (lien à usage unique, valable jusqu'au ${expiresAt}) :`);
console.log(`${config.siteUrl}/reinitialisation/${token}`);
