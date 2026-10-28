# Fiche 26 — SCIM : que l'accès suive l'annuaire

## 1. Le problème : l'oubli

Une personne quitte l'entreprise le vendredi. Son compte Microsoft est
désactivé… mais son compte Snowfall, lui, reste ouvert tant que personne ne
pense à le retirer. C'est l'une des causes de fuite les plus banales : l'accès
d'un ancien salarié, ou d'un prestataire parti.

## 2. SSO et SCIM, deux choses différentes

- Le **SSO** (OIDC, SAML) dit **qui se connecte**. Il ne prévient pas quand
  quelqu'un part : il attend simplement la prochaine connexion.
- Le **SCIM** (RFC 7643/7644) **pousse les changements**. L'annuaire appelle
  Snowfall pour créer, modifier, désactiver ou supprimer un compte, au moment où
  ça se passe.

Les deux ensemble : l'annuaire dit qui a le droit (SCIM), le SSO vérifie que
c'est bien lui (connexion).

## 3. Le piège : revenir par la porte du SSO

Avant le SCIM, Snowfall laissait entrer tout utilisateur de l'annuaire lié en
SSO (« provisioning juste à temps »). Si l'on ajoutait le SCIM sans rien
changer d'autre, une personne désactivée **reviendrait à sa connexion
suivante** par le SSO : le retrait ne servirait à rien.

D'où la règle : une organisation qui a une clé SCIM (ou des comptes SCIM) est
**gérée par l'annuaire**. Seul un compte actif y entre, SSO compris. C'est testé
sur la vraie fonction de connexion : désactivé, puis reconnecté, refusé.

Un second cas, trouvé en relisant : si l'annuaire supprime **tous** les
comptes, l'organisation n'aurait plus de ligne SCIM… et redeviendrait ouverte.
La clé SCIM active suffit donc à la garder sous l'annuaire.

## 4. Couper vraiment l'accès

Retirer l'appartenance suffit, parce que Snowfall relit l'appartenance **à
chaque requête** : une session encore ouverte ne sert plus à rien dès la requête
suivante. Une application qui garderait le rôle en cache dans la session
devrait, elle, révoquer les sessions, sinon le retrait n'aurait d'effet qu'à la
déconnexion.

## 5. Ne jamais échouer en silence

Si un retrait est impossible (on ne retire pas un propriétaire par une clé
d'administrateur), Snowfall répond une **erreur à l'annuaire** et l'inscrit dans
l'audit. Répondre « OK » sans rien faire laisserait l'accès ouvert sans que
personne le sache : c'est pire qu'une erreur visible.

## 6. Moindre donnée

Un annuaire envoie beaucoup : téléphone, poste, manager, adresse… Snowfall ne
garde que l'adresse, l'identifiant externe, le nom affiché et l'état actif. Une
donnée qu'on ne garde pas ne peut pas fuir.

## 7. À retenir

- SSO = qui se connecte ; SCIM = qui a le droit, poussé en temps réel.
- Ajouter le SCIM impose de fermer l'entrée par le seul SSO.
- L'accès doit être relu à chaque requête (ou les sessions révoquées).
- Un retrait qui échoue se signale, jamais en silence.
- Garder le minimum de ce que l'annuaire envoie.
