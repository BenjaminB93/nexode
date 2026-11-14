// Contrats entre couches. Le catalogue (cache TMDB, src/infra/catalog.ts) est consommé par les use cases.

export type SearchResult = {
  id: number;                 // id TMDB
  name: string;
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
  // Recherche TMDB en direct (pas de cache), en français.
  searchShows(query: string): Promise<SearchResult[]>;
}
