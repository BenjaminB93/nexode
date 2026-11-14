// « Où regarder » sur la fiche série : saisons consécutives aux plateformes identiques regroupées.

export type ProviderItem = { id: number; name: string; logoPath: string | null };
export type SeasonProviders = { season: number; items: readonly ProviderItem[] };   // items triés par priorité
export type ProviderGroup = { from: number; to: number; label: string | null; items: ProviderItem[] };

// Libellé (« Saison 1 », « Saisons 2–3 ») seulement s'il y a plusieurs groupes. Une saison sans plateforme coupe le groupe.
export function providerGroups(seasons: readonly SeasonProviders[]): ProviderGroup[] {
  const groups: { sig: string; from: number; to: number; items: ProviderItem[] }[] = [];
  for (const s of [...seasons].sort((a, b) => a.season - b.season)) {
    if (!s.items.length) continue;
    const sig = s.items.map((p) => p.id).join(',');
    const last = groups.at(-1);
    if (last && last.sig === sig && last.to === s.season - 1) last.to = s.season;
    else groups.push({ sig, from: s.season, to: s.season, items: [...s.items] });
  }
  return groups.map((g) => ({
    from: g.from,
    to: g.to,
    label: groups.length > 1 ? (g.from === g.to ? `Saison ${g.from}` : `Saisons ${g.from}–${g.to}`) : null,
    items: g.items,
  }));
}
