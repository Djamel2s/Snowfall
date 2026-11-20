# Registre des preuves d'exploitation

Chaque ligne est une preuve datée, reproductible par la commande indiquée.
Les exercices tournent aussi en CI (job `operations`) : le journal de chaque
exécution est une preuve de plus. En production, ajouter ici le test mensuel
`backup-verify` (RUNBOOK § 13) et les exercices sur table (INCIDENT_RESPONSE § 7).

| Date (UTC) | Exercice | Commande | Résultat | Mesures | Constat |
|---|---|---|---|---|---|
| 2026-11-01 12:40 | Sauvegarde et restauration complètes (base jetable, 61 tables, 86 migrations, 20 conversations chiffrées de référence) | `scripts/restore-drill.sh` | `backup_ok`, `restore_test_ok`, `drill_verify_ok conversations=20 decrypted=yes rls=yes`, `drill_restore_ok`, `drill_wrong_key_ok` | Sauvegarde 1 s (304 Ko) ; test de restauration 2 s ; **RTO 9 s** (petite base : à remesurer sur une base réaliste) | **Défaut trouvé et corrigé** : la procédure écrite (RUNBOOK § 13) s'arrêtait à la restauration ; sans `db:setup`, la migration échouait et l'API n'avait aucun droit. Procédure corrigée, exercice en CI. |
| 2026-11-01 12:48 | Chaîne d'alerte de bout en bout (vraies règles, vraies configurations, réseau jetable) | `scripts/alert-drill.sh` | `drill_ok alert=SauvegardeEchouee`, `drill_ok alert=SnowfallApiInjoignable` | Sauvegarde échouée → e-mail : **93 s** ; API injoignable → e-mail : **201 s** (2 min de confirmation voulues + collecte + regroupement) | Règles Loki prouvées en les déclenchant (l'outil de Loki ne les valide pas). Deux erreurs de l'exercice lui-même corrigées avant la preuve : stockage temporaire de Loki non inscriptible, chemins de configuration. |
| 2026-11-01 12:30 | Tests unitaires des alertes (18 règles Prometheus) et configurations | `scripts/monitoring-test.sh` | `SUCCESS` (promtool, amtool), configuration de Loki valide | — | Les tests mordent : délai d'alerte raccourci ou seuil relevé → échec (vérifié). |
