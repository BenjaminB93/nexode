import type { Db } from '../../src/db/index.ts';
import type { Role } from '../../src/domain/accounts.ts';
import { usernameKey } from '../../src/domain/accounts.ts';
import { insertUser } from '../../src/infra/repos.ts';
import { openSession } from '../../src/usecases/auth.ts';

// Comptes et sessions de test, écrits directement en base.

// pwHash '!' par défaut : le compte ne peut pas se connecter par mot de passe (session créée par sessionCookie).
export function addUser(db: Db, username: string, opts: { role?: Role; pwHash?: string; invitedBy?: number | null; now?: string } = {}): number {
  return insertUser(db, {
    username, usernameKey: usernameKey(username), pwHash: opts.pwHash ?? '!', role: opts.role ?? 'membre',
    invitedBy: opts.invitedBy ?? null, createdAt: opts.now ?? '2026-11-01T00:00:00.000Z',
  });
}

// En-tête Cookie d'une nouvelle session du compte.
export function sessionCookie(db: Db, userId: number, now: string): string {
  return `sid=${openSession({ db, now: new Date(now) }, userId)}`;
}
