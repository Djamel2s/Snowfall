# Catalogue d'agents

Les agents prêts à l'emploi de Snowfall. Ce sont des données, pas du code : on les
modifie sans toucher au TypeScript. L'API les lit et les valide au démarrage, et
un fichier invalide l'empêche de démarrer. Rien n'est écrit en base : chaque
organisation installe ce qu'elle veut depuis l'onglet « Catalogue », par les
routes ordinaires, avec les mêmes contrôles qu'une création manuelle.

```
catalog.json                          ordre d'affichage (tout dossier doit y figurer)
agents/<id>/
  README.md                           pourquoi cet agent, choix de conception
  agent.json                          fiche : nom, outils, connecteurs, limites, compétences (ordre)
  instructions.md                     prompt système (4 000 caractères au plus)
  skills/<nom>/SKILL.md               compétence : en-tête name / description, puis la procédure
  skills/<nom>/*.py                   scripts exécutés dans le bac à sable (et références)
  evals/cases.json                    jeu d'évaluation (au moins 5 cas, dont un de sécurité)
  evals/*                             pièces jointes et documents des cas
```

## Modifier ou ajouter un agent

1. Copier le dossier d'un agent proche et changer `id` (le nom du dossier) dans `agent.json`.
2. Ajouter l'identifiant dans `catalog.json`.
3. `npm test -w @snowfall/api` : limites, détecteurs (données sensibles, injection),
   connecteurs existants, outils réellement proposés aux cas.
4. Mesurer sur un vrai modèle et lire les échecs avant de corriger :
   `npm run agent:eval -w @snowfall/api -- --model <fournisseur:modèle> --template <id> --repeat 3`
   (ajouter `--sandbox` si l'agent exécute du code).
5. Reporter la mesure dans `measured` (`agent.json`).

Un agent déjà installé est une copie : le modifier ici ne change pas les agents installés.
Le contenu juridique (RH, contrats, RGPD) est à relire par l'organisation avant usage.
