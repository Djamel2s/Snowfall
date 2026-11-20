# Réponse à incident

Ce plan s'applique à tout événement qui menace la confidentialité, l'intégrité
ou la disponibilité de Snowfall ou de ses données : panne, fuite, compromission,
abus d'un agent. Il est exercé (voir § 7) et chaque exercice laisse une preuve
dans le [registre des preuves](PREUVES.md).

## 1. Rôles

| Rôle | Qui | Responsabilités |
|---|---|---|
| Responsable d'incident | Astreinte exploitation (désignée au planning) | Déclare l'incident, fixe la gravité, coordonne, tient le journal |
| Expert technique | Développeur de garde | Diagnostic, confinement, correctif |
| Délégué à la protection des données (DPO) | DPO de l'organisation cliente, et celui de l'éditeur | Qualifie la violation de données, notifie la CNIL et les personnes |
| Communication | Direction | Messages aux clients et, si besoin, au public |

Une seule personne peut cumuler les rôles sur une petite équipe, jamais
celui de DPO.

## 2. Gravité

| Niveau | Exemples | Délai de prise en charge |
|---|---|---|
| **S1 critique** | Fuite de données personnelles ; clé maître ou KMS compromis ; API injoignable pour tous ; sauvegardes impossibles | 15 minutes, 24 h/24 |
| **S2 majeur** | Un fournisseur de modèle en panne ; antivirus indisponible (dépôts refusés) ; restauration en échec | 1 heure ouvrée |
| **S3 mineur** | Lenteurs ; un outil (recherche web, OCR) indisponible ; budget atteint | Dans la journée |

Les alertes portent déjà ce niveau : `critical` (S1), `warning` (S2 ou S3).

## 3. Déroulé

1. **Détecter** — alerte (e-mail d'Alertmanager), signalement d'un utilisateur,
   SIEM. Le responsable ouvre le journal d'incident (modèle § 6), heure UTC.
2. **Qualifier** — gravité, périmètre (organisations, personnes, données),
   données personnelles en jeu ? Si oui : prévenir le DPO **immédiatement**.
3. **Confiner** — selon le cas (§ 4) : couper l'accès, révoquer, isoler.
   Ne rien effacer : les journaux et l'audit sont des preuves.
4. **Éradiquer et rétablir** — correctif, restauration (RUNBOOK § 13),
   rotation des clés (RUNBOOK § 3). Vérifier avant de rouvrir.
5. **Notifier** — voir § 5.
6. **Retour d'expérience** — sous 5 jours ouvrés : chronologie, cause,
   ce qui a marché, actions (avec responsable et date). Le modèle de menaces
   et le RUNBOOK sont mis à jour.

## 4. Fiches réflexes

| Situation | Premiers gestes |
|---|---|
| API injoignable (`SnowfallApiInjoignable`) | `docker compose ps` ; journaux de l'API (Grafana › Loki) ; base joignable (`PostgresInjoignable`) ? redémarrage du service ; si la base est perdue : restauration (RUNBOOK § 13) |
| Fichier infecté (`SnowfallMenaceDetectee`) | Rien à faire pour le fichier (refusé, jamais stocké). Identifier le compte dans l'audit (`security.malware_detected`) ; si répété : suspendre le compte |
| Énumération ou force brute (`SnowfallAccesCroises`, `SnowfallEchecsConnexion`) | Identifier les comptes et adresses (audit) ; bloquer au pare-feu ; forcer la déconnexion (Keycloak) ; réinitialiser les identifiants concernés |
| Clé d'API ou jeton fuité | Révoquer la clé (Administration › Clés d'API) ; audit des appels de la clé ; si un jeton OAuth de connecteur : déconnexion du connecteur |
| Clé maître ou KMS suspect (`KmsAccesRefuse`) | Révoquer l'AppRole de l'API dans OpenBao ; nouvelle clé de chiffrement (RUNBOOK § 3, rotation) ; S1 |
| Injections en série (`SnowfallInjectionsSuspectees`) | Identifier la source (document, page web, connecteur) dans l'audit ; retirer le document ; désactiver le connecteur |
| Sauvegarde ou restauration en échec | Lancer la sauvegarde à la main (`BACKUP_RUN_ONCE=true`), lire l'erreur ; ne pas attendre le lendemain : S2 |
| Budget atteint (`SnowfallBudgetAtteint`) | Pas un incident de sécurité : prévenir l'administrateur de l'organisation (Administration › Coûts) |

## 5. Notifications

- **CNIL** : une violation de données personnelles est notifiée **dans les
  72 heures** après en avoir pris connaissance (RGPD, art. 33), sauf si elle
  n'engendre vraisemblablement aucun risque (à justifier dans le registre des
  violations, tenu dans tous les cas). Notification par le responsable de
  traitement (l'organisation cliente) ; Snowfall, sous-traitant, prévient ce
  dernier **sans délai** (art. 33.2) avec les éléments connus.
- **Personnes concernées** : si le risque est élevé (art. 34), par le
  responsable de traitement.
- **Clients** : toute indisponibilité S1 de plus d'une heure, et toute violation
  touchant leurs données.
- **Autres** : ANSSI (CERT-FR) pour un incident cyber significatif ; l'assureur ;
  le dépôt de plainte s'il y a lieu.

## 6. Modèle de journal d'incident

```
Incident n° AAAA-MM-JJ-n      Gravité : S1/S2/S3      Responsable :
Détection (UTC) :             Source : alerte / utilisateur / SIEM
Périmètre : organisations, personnes, données (catégories)
Données personnelles en jeu : oui / non   DPO prévenu (UTC) :
Chronologie (UTC) : heure — action — qui
Confinement (UTC) :           Rétablissement (UTC) :
Notifications : CNIL (UTC, n°), clients (UTC), personnes (UTC)
Cause :
Actions correctives : action — responsable — échéance
```

## 7. Exercices

| Exercice | Fréquence | Comment | Preuve |
|---|---|---|---|
| Restauration complète | Mensuel (et en CI) | `scripts/restore-drill.sh` ; en production : `backup-verify` (RUNBOOK § 13) | Lignes `restore_test_ok`, `drill_restore_ok rto_s=…` |
| Chaîne d'alerte | Trimestriel (et en CI) | `scripts/alert-drill.sh` : panne simulée → e-mail | Lignes `drill_ok alert=… delay_s=…` |
| Tests des alertes | À chaque modification (CI) | `scripts/monitoring-test.sh` | Sortie de promtool |
| Exercice sur table | Semestriel | Un scénario de § 4 joué avec les rôles de § 1, chronométré, sans toucher la production | Journal d'incident (§ 6) marqué « exercice », dans le registre des preuves |

Objectifs : **RTO** (temps de reprise) 4 heures, **RPO** (perte maximale de
données) 24 heures — une sauvegarde par jour, copie hors site immuable.
