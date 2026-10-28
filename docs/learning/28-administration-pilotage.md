# 28 — Un espace d'administration, et un tableau de bord qui ne surveille personne

## 1. Pourquoi un espace à part

Les Paramètres mélangeaient deux publics :
- ce qui me concerne : ma langue, mon thème, ma mémoire ;
- ce qui concerne l'organisation : les quotas de tous, les membres, le SSO.

Chaque nouvelle fonction d'administration y ajoutait une carte, et le tableau
de bord aurait été la onzième.

La règle est désormais simple :
- **Paramètres** = mon compte ;
- **Administration** = l'organisation, avec sa propre icône, visible des
  administrateurs seulement.

Une fonction s'insère dans une rubrique existante, ou en crée une si elle le
justifie.

Pourquoi pas une application séparée (`admin.…`) ? Il faudrait deux
déploiements, deux sessions et deux politiques CSP, pour un gain faible
aujourd'hui. L'isolation réelle est ailleurs : dans la base, voir le § 3.

La **console opérateur**, celle qui verrait toutes les organisations, a été
refusée volontairement. Un accès à tous les clients casserait la promesse de
souveraineté et deviendrait la cible n°1.

## 2. Ce qu'une direction veut savoir, sans surveiller

Ce que la direction demande :
- est-ce adopté ?
- quels agents servent, et sont-ils utiles ?
- combien ça consomme ?

Ce qu'elle ne doit **pas** obtenir : qui travaille combien.

En France, un suivi individuel de l'activité des salariés relève :
- du RGPD : finalité, proportionnalité, analyse d'impact ;
- de l'information et de la consultation du CSE.

Le tableau de bord ne montre donc que des **totaux**, et applique un **seuil de
5 personnes** pour l'usage d'un agent. Sous ce seuil, un chiffre désignerait
presque quelqu'un : « l'agent Paie, 1 personne, 300 messages ». C'est la même
idée que la *k-anonymité*, et le même seuil que le taux de 👍.

## 3. Compter sans lire

Les messages sont protégés par la RLS : seul leur auteur peut les lire, même
pas l'administrateur. Comment les compter, alors ?

Le **même schéma** que pour le taux de 👍 :
1. un **trigger** sur `messages` ajoute +1 dans `member_activity`, avec
   l'organisation, le jour, la personne, l'agent et un nombre, sans aucun
   contenu ;
2. le rôle applicatif n'a **aucun droit** sur cette table ;
3. il ne peut appeler que `snowfall_admin_overview(jours)`. Cette fonction
   `SECURITY DEFINER` vérifie **elle-même** que l'appelant est administrateur de
   l'organisation du contexte, puis rend des totaux.

C'est une **défense en profondeur** : la route vérifie le rôle, et la base le
vérifie aussi. Un jeton qui dit encore « admin » après une rétrogradation est
refusé par la base. Le test « rôle périmé » le prouve.

## 4. Qu'est-ce qu'une « activité » ?

Le trigger compte chaque insertion d'un message de l'utilisateur. La revue
critique a trouvé deux insertions qui ne sont pas une activité :
- la **copie** d'une conversation, qui recopie ses messages ;
- l'**import** d'un historique ChatGPT : 500 messages importés seraient devenus
  « 500 messages envoyés aujourd'hui ».

La correction : ces transactions posent un drapeau (`app.copy`), que le trigger
respecte. Ce drapeau ne peut que *retirer* du comptage, jamais en ajouter. Un
défaut de l'application ne peut donc pas gonfler les chiffres.

Il reste un écart, assumé et documenté : les tâches planifiées et l'API
publique comptent comme activité de leur auteur.

## 5. Tester les tests, par mutation

Un test qui passe du premier coup ne prouve rien tant qu'on ne l'a pas vu
échouer. Sur une base jetable, deux mutations ont été essayées :
- donner au rôle applicatif le droit de lire `member_activity` : le test
  échoue ;
- abaisser le seuil de 5 personnes à 1 : le test échoue.

Les deux échecs attendus sont arrivés, puis la vraie fonction a été remise en
place. C'est la même idée qu'au § 5 de la fiche 27 : le banc d'essai lui-même
doit être vérifié.

## 6. À retenir

- Séparer « moi » et « l'organisation » dans l'interface, et le garantir dans
  la base, pas seulement dans l'interface.
- Une statistique sur des personnes est une donnée personnelle. Agréger, poser
  un seuil, conserver pour une durée limitée (ici 13 mois).
- Pour compter ce qu'on ne peut pas lire : une table de comptage sans contenu,
  plus une fonction qui contrôle les droits.
- Définir ce qu'on mesure (« une activité ») et chercher ce qui le fausse.
