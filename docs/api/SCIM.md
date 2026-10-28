# Provisionnement SCIM 2.0

L'annuaire de l'entreprise (Microsoft Entra ID, Okta, Google…) crée et retire
automatiquement les comptes Snowfall. Quand quelqu'un quitte l'entreprise, son
accès s'arrête sans que personne ait à y penser.

## Ce que fait le SCIM dans Snowfall

| L'annuaire… | Snowfall… |
|---|---|
| crée un compte actif | l'autorise : la personne rejoint l'organisation à sa première connexion (rôle par défaut de l'organisation) |
| désactive le compte | retire son appartenance (et ses partages, ses invitations en attente) : l'accès s'arrête à la requête suivante, même avec une session ouverte |
| réactive le compte | l'autorise de nouveau : la personne revient à sa connexion suivante |
| supprime le compte | retire l'accès, puis supprime le compte SCIM |

Dès qu'une **clé SCIM** existe (ou que l'annuaire a poussé des comptes),
l'organisation est **gérée par l'annuaire** : l'entrée par le seul SSO n'est
plus possible. Seul un compte actif dans l'annuaire entre. Sinon, une personne
désactivée reviendrait simplement en se reconnectant.

Le rôle (membre, lecteur…) n'est pas géré par le SCIM : c'est le rôle par
défaut de l'organisation, qu'un administrateur peut changer ensuite dans
Snowfall.

## Mise en place

1. Dans Snowfall : **Administration › Membres et accès ›
   Provisionnement SCIM**. Créez une clé (« Entra ID ») et copiez-la : elle
   n'est affichée qu'une fois. Notez l'adresse affichée
   (`https://<votre-snowfall>/api/scim/v2`).
2. Dans l'annuaire, configurez une application SCIM 2.0 :
   - **Microsoft Entra ID** : Applications d'entreprise › votre application ›
     Approvisionnement › Automatique. « URL du locataire » = l'adresse ci-dessus ;
     « Jeton secret » = la clé. Testez la connexion, puis attribuez les
     utilisateurs ou les groupes.
   - **Okta** : Applications › votre application › Provisioning › Integration.
     « SCIM connector base URL » = l'adresse ; « Unique identifier field for
     users » = `userName` ; « Authentication Mode » = HTTP Header (Bearer) = la
     clé. Activez *Create Users*, *Update User Attributes*, *Deactivate Users*.
3. `userName` doit être l'adresse e-mail de la personne (ou son adresse
   principale dans `emails`), la même que celle de son compte de connexion.

## Points d'accès

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/scim/v2/ServiceProviderConfig` | Capacités (filtre, PATCH) |
| GET | `/scim/v2/ResourceTypes` | Ressource « User » |
| GET | `/scim/v2/Users?filter=userName eq "…"` | Recherche (aussi `externalId eq "…"`) |
| GET | `/scim/v2/Users/{id}` | Lecture |
| POST | `/scim/v2/Users` | Création |
| PUT | `/scim/v2/Users/{id}` | Remplacement |
| PATCH | `/scim/v2/Users/{id}` | Modification (dont `active`) |
| DELETE | `/scim/v2/Users/{id}` | Suppression |

Les groupes SCIM ne sont pas encore pris en charge : attribuez l'application à
des groupes dans l'annuaire, Snowfall ne reçoit que leurs membres.

## Sécurité

- La clé SCIM agit au nom de l'administrateur qui l'a créée, et seulement tant
  qu'il est administrateur. Elle n'ouvre que `/scim/v2`, jamais l'API des agents
  ni l'interface.
- Seuls l'adresse, l'identifiant externe, le nom affiché et l'état actif sont
  gardés. Le reste (téléphone, poste, manager…) est ignoré (moindre donnée).
- Un retrait impossible (un propriétaire, ou le créateur de la clé lui-même)
  est **signalé à l'annuaire** (erreur 409) et tracé (`scim.deprovision`, échec),
  jamais ignoré en silence.
- Audit : `scim.user_create`, `scim.user_update`, `scim.user_deactivate`,
  `scim.user_delete`, `scim.deprovision`.
