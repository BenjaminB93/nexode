import type { Db } from '../db/index.ts';
import type { Catalog } from '../ports.ts';
import { todayIn } from '../domain/dates.ts';

export type User = { id: number; country: string; timezone: string; shelveAfterDays: number };

// Contexte d'une requête : l'instant now est figé pour toute l'action.
export type Ctx = { db: Db; catalog: Catalog; user: User; now: Date };

export const nowIso = (ctx: Ctx) => ctx.now.toISOString();
export const today = (ctx: Ctx) => todayIn(ctx.user.timezone, ctx.now);

// Erreurs métier ; la couche HTTP les traduit en codes de statut.
export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
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
    super('invalid_input', `entrée invalide : ${field}`);
    this.field = field;
  }
}
export class UpstreamError extends AppError {
  constructor(message: string) { super('catalog_unavailable', message); }
}
