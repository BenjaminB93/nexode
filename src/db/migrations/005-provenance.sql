-- Provenance d'un visionnage. single = 1 : épisode marqué seul (swipe, coche), son heure date un vrai visionnage.
-- single = 0 : marqué en lot (« jusqu'ici », saison) ou importé sans provenance connue ; son heure date seulement le marquage.
-- Les statistiques de rythme (binge, saison dévorée, mois) ne comptent que single = 1.
ALTER TABLE watched ADD COLUMN single INTEGER NOT NULL DEFAULT 0 CHECK (single IN (0, 1));
