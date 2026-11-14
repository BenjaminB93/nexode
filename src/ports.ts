// Contrats entre couches. Le catalogue (cache TMDB, src/infra/catalog.ts) est consommé par les use cases.
import type { NotifPayload } from './domain/notifications.ts';

export type SearchResult = {
  id: number;                 // id TMDB
  name: string;
  originalName: string;
  year: number | null;
  posterPath: string | null;  // chemin TMDB, ex. '/abc.jpg'
};

export interface Catalog {
  // Garantit que la série, ses saisons (≥ 1) et ses épisodes sont en base. Appelle TMDB seulement si absente ou plus vieille que 24 h.
  ensureShow(showId: number): Promise<void>;
  // Force la mise à jour depuis TMDB (rafraîchissement quotidien), sans jamais supprimer un épisode vu par quelqu'un.
  refreshShow(showId: number): Promise<void>;
  // Plateformes de chaque saison pour un pays ; relevé au plus une fois par 24 h.
  ensureProviders(showId: number, country: string): Promise<void>;
  // Pays couverts par JustWatch (codes ISO, triés) ; relevés au plus une fois par 24 h.
  regions(): Promise<string[]>;
  // Recherche TMDB en direct (pas de cache), en français ; year = année de première diffusion.
  searchShows(query: string, year?: number): Promise<SearchResult[]>;
  // Id TMDB d'une série d'après son id TheTVDB (imports) ; null si inconnue. Lit d'abord le cache local.
  findShowByTvdb(tvdbId: number): Promise<number | null>;
  // Position TMDB d'un épisode d'après son id TheTVDB ; null si inconnu.
  findEpisodeByTvdb(tvdbEpisodeId: number): Promise<{ showId: number; season: number; number: number } | null>;
}

// Envoi Web Push (src/infra/webpush.ts). gone : abonnement refusé définitivement (404/410), à supprimer.
export type PushResult = 'sent' | 'gone' | 'failed';

export interface Push {
  publicKey: string;        // clé VAPID publique (applicationServerKey du navigateur)
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: NotifPayload): Promise<PushResult>;
}
