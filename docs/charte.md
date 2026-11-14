# Charte graphique de Nexode

Les valeurs vivent dans [public/app/style.css](../public/app/style.css) (variables CSS) ; ce document en donne les rôles et les règles. Les contrastes sont vérifiés par [test/front-contrast.test.ts](../test/front-contrast.test.ts) (`npm test`).

## Logo

Le « o » de Nexode. Anneau ouvert en trait plein (épisodes vus), flèche arrondie à 3 h pointant vers la droite (le prochain épisode), deux points qui s'effacent dessous (la suite).

Tous les fichiers de la marque sont générés par [tools/brand.ts](../tools/brand.ts), qui porte la construction ci-dessous : `node tools/brand.ts` sur le PC (dépendances de développement resvg-js et opentype.js, absentes de l'image Docker). L'outil refuse de générer si deux éléments de la marque se touchent presque.

- [docs/logo/](logo/) : `nexode-icone-sombre.svg` (icône principale), `nexode-icone-ambre.svg` (fond ambre, marque foncée, flèche blanche), `nexode-marque.svg` (marque seule), `nexode-nom-sombre.svg` et `nexode-nom-clair.svg` (nom écrit).
- [public/icons/](../public/icons/) : `icon.svg` (onglet), `icon-192.png` et `icon-512.png` (coins arrondis), `maskable-512.png` (pleine, Android découpe), `apple-touch-icon.png` (180, pleine, iOS arrondit), `badge-96.png` (marque blanche sur transparent, barre de notifications Android).
- [public/app/brand.js](../public/app/brand.js) : le nom écrit en tracés, affiché par `Wordmark(hauteur)` ([components.js](../public/app/components.js)) aux couleurs du thème.

Construction (boîte 512, centre 256, angles comptés depuis midi dans le sens horaire) :

| Élément | Valeur |
|---|---|
| Anneau | rayon 150, trait 44, bouts ronds, de 188° à 405° (45°) |
| Flèche | triangle à 90° (3 h), pointe vers la droite, longueur 80, base 92, coins ronds (trait 20) |
| Traîne | points à 130° (rayon 15, opacité 0,9) et 158° (rayon 11, opacité 0,55) |
| Cadrage | ensemble recentré sur sa boîte englobante ; tout tient dans le cercle de rayon 205 (zone sûre des icônes Android « maskable ») |

Couleurs de l'icône sombre : anneau `#D3D8DF`, flèche `#F2B544`, traîne `#6B7380`, fond dégradé `#1F232C` → `#0F1115`. Icône ambre : fond `#F7C663` → `#EBA62C`, anneau et traîne `#1A1406`, flèche `#FFFFFF`.

**Nom écrit** : « nexode » en minuscules, Space Grotesk 700, approche -0,02 em, la marque à la place du o (hauteur 0,54 em, trait 20 sur une boîte de 100 pour égaler les jambages). La flèche pointe vers « de ». Dans le nom écrit, l'arc va de 201° à 393° et la traîne est décalée (138°, 166°) pour garder au moins 2 px entre les éléments à 48 px. Lettres et anneau couleur du texte, flèche `--accent`, traîne `--dim`.

Règles : pas de bouton lecture centré, de jauge, d'horloge ni de « … » (le logo ne doit rappeler aucun objet connu). Au-dessous de 32 px, la traîne disparaît dans le flou : c'est accepté.

## Couleurs

Thème sombre par défaut, thème clair choisi dans Profil (ou par le système). Une couleur se choisit par son **rôle**, jamais par sa valeur : aucune couleur en dur dans les vues.

| Variable | Rôle | Sombre | Clair |
|---|---|---|---|
| `--bg` | fond de l'écran | `#0E1014` | `#F5F6F8` |
| `--card`, `--sheet`, `--bar` | cartes, feuilles du bas, barre d'onglets | `#171A21` · `#1A1E26` · `#12151A` | `#FFFFFF` |
| `--fg` | texte principal | `#ECEEF1` | `#15181D` |
| `--soft` | texte secondaire appuyé | `#C9CED6` | `#39404B` |
| `--muted` | texte secondaire | `#9BA3AF` | `#5B6370` |
| `--faint` | texte discret (mentions, dates, liens sortants) | `#808892` | `#666D79` |
| `--dim` | icônes discrètes (chevrons), **jamais du texte** | `#6B7380` | `#808894` |
| `--accent` | « à regarder » : texte et filets ambre (code d'épisode, fil d'Ariane, onglet actif) | `#F2B544` | `#936008` |
| `--accent-solid` + `--on-accent` | fond de bouton principal et texte dessus | `#F2B544` + `#1A1406` | identique |
| `--accent-bg` | pastille ambre (fond, texte `--accent`) | `#2A2414` | `#FAEFD8` |
| `--ok` + `--on-ok` | « vu » : texte, coche pleine et sa marque | `#3CCB9B` + `#0E1014` | `#187E5D` + `#FFFFFF` |
| `--ok-bg` + `--ok-fg` | pastille « À jour » | `#123328` + `#9FD9C2` | `#DCF2E9` + `#166A4F` |
| `--danger` + `--on-danger` | suppression, erreurs ; bouton de confirmation | `#F08A7E` + `#2A0F0B` | `#C4453A` + `#FFFFFF` |
| `--hist`, `--hist-strong` sur `--hist-bg` | historique de la timeline (grisé) | `#8A929E`, `#A3AAB5` sur `#13161C` | `#6A727E`, `#4D5562` sur `#FFFFFF` |

Les autres variables (`--line*`, `--chip*`, `--tick-off`, `--toast`, `--backdrop`, `--shadow`…) sont des filets, fonds de contrôle et ombres.

**Contrastes** (WCAG AA) : texte ≥ 4,5:1 sur chacun de ses fonds ; élément graphique qui porte une information (coche, icône) ≥ 3:1. La liste des couples vérifiés est dans le test ; un nouveau couple rôle/fond s'y ajoute.

L'ambre a deux valeurs en thème clair : vif pour les fonds (`--accent-solid`, texte foncé dessus), foncé pour le texte (`--accent`), car un ambre lisible en texte sur blanc est trop sombre pour un bouton.

## Polices

| Police | Usage | Graisses |
|---|---|---|
| **Inter** (`--text`) | tout le texte de l'interface | 400, 500, 600, 700 |
| **Space Grotesk** (`--display`) | titres d'écran et de feuille, en-têtes de section, initiale de l'avatar, nom écrit | 700 |

Fichiers variables servis par l'appli depuis [public/vendor/fonts/](../public/vendor/fonts/) (licence SIL OFL 1.1, voir [LICENSES.txt](../public/vendor/LICENSES.txt)) : sous-ensemble latin préchargé (Inter 48 Ko, Space Grotesk 22 Ko), latin-ext chargé seulement si un texte en contient un caractère. Pas de CDN.

Tailles principales en px : 11 (étiquettes en capitales, espacées) · 12 · 13 · 14 · 15 (texte courant) · 18 · 19 · 22 (titre d'écran) · 26. Une nouvelle taille se justifie ; sinon on reprend la plus proche.

## Formes et icônes

- Rayons : 16 px cartes et groupes, 12–14 px boutons et champs, 10 px petits contrôles, cercle pour les pastilles rondes.
- Icônes : traits SVG en `currentColor`, boîte 24, trait 2 (2,2 à 3 pour les coches), bouts et angles ronds ([icons.js](../public/app/icons.js)).
- Zones tactiles : 44 px minimum.

## Mouvement

Voir « Animations » dans [CLAUDE.md](../CLAUDE.md) : ≤ 0,3 s, glissement latéral entre écrans, jamais de décalage de mise en page, coupé si le système demande moins d'animations.
