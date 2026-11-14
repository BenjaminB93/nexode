import type { Db } from '../db/index.ts';
import type { Catalog } from '../ports.ts';
import type { Role } from '../domain/accounts.ts';
import { todayIn } from '../domain/dates.ts';

export type User = { id: number; role: Role; country: string; timezone: string; shelveAfterDays: number };

// Contexte sans utilisateur (connexion, inscription, réinitialisation) : l'instant now est figé pour toute l'action.
export type Base = { db: Db; now: Date };
// Contexte d'une requête authentifiée.
export type Ctx = Base & { catalog: Catalog; user: User };

export const nowIso = (ctx: Base) => ctx.now.toISOString();
export const today = (ctx: Pick<Ctx, 'now' | 'user'>) => todayIn(ctx.user.timezone, ctx.now);

// Erreurs métier ; la couche HTTP les traduit en codes de statut. details est ajouté au corps de la réponse.
export class AppError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number>;
  constructor(code: string, message?: string, details: Record<string, string | number> = {}) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}
export class NotFoundError extends AppError {
  constructor(what: string) { super('not_found', `${what} introuvable`); }
}
export class NotAiredError extends AppError {
  constructor(episodeIds: readonly number[]) { super('not_aired', `épisode pas encore sorti : ${episodeIds.join(', ')}`); }
}
export class InvalidInputError extends AppError {
  readonly field: string;
  constructor(field: string) {
    super('invalid_input', `entrée invalide : ${field}`, { field });
    this.field = field;
  }
}
export class UpstreamError extends AppError {
  constructor(message: string) { super('catalog_unavailable', message); }
}
export class ForbiddenError extends AppError {
  constructor() { super('forbidden', 'rôle insuffisant'); }
}
