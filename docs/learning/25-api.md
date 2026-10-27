# Fiche 25 — L'API Snowfall : ouvrir une porte sans affaiblir la maison

## 1. Pourquoi une API ?

Une suite d'IA vit là où les gens travaillent : l'intranet, Teams, un outil
métier. Ces logiciels ne peuvent pas « cliquer » dans Snowfall : ils ont besoin
d'une **API** (une interface pour les programmes). C'est la brique sur laquelle
reposeront les étapes suivantes (Teams, Outlook, workflows).

## 2. Une clé d'API, ce n'est pas une session

L'interface utilise un **cookie de session** : le navigateur l'envoie tout seul.
C'est pratique, mais c'est aussi ce qui rend possible le CSRF (fiche 3) : un
autre site peut faire envoyer le cookie. D'où le contrôle de l'origine.

Une application, elle, envoie une **clé dans un en-tête**
(`Authorization: Bearer …`). Rien n'est envoyé automatiquement, donc pas de CSRF.
En contrepartie, la clé doit rester **côté serveur** : dans un navigateur,
n'importe qui pourrait la lire.

Règle appliquée : les routes `/v1` n'acceptent **que** la clé, et les routes de
l'interface **que** la session. Une clé volée n'ouvre pas l'interface, et une
session volée n'ouvre pas l'API.

## 3. Ne jamais stocker la clé

Comme un mot de passe, la clé n'est gardée que sous forme d'**empreinte**
(SHA-256). À chaque appel, on calcule l'empreinte de la clé reçue et on la
cherche. Une fuite de la base ne donne aucune clé utilisable.

Pourquoi SHA-256 suffit ici, alors qu'un mot de passe exige un hachage **lent**
(Argon2, bcrypt) ? Un mot de passe humain est devinable : on ralentit les essais.
Une clé contient ≈ 300 bits de hasard : aucun essai n'aboutira jamais, même très
rapide.

On affiche aussi un **préfixe** (`snowfall_sk_Ab3Ab3…`) : de quoi reconnaître
la clé dans une liste ou un journal, jamais de quoi l'utiliser.

## 4. Au nom de qui agit la clé ?

Une API sans identité contourne tout : la RLS, l'audit et les quotas sont
pensés pour des personnes. Choix fait : une clé agit **au nom de
l'administrateur qui l'a créée**, avec trois limites :

- seulement les **agents listés** sur la clé (moindre privilège) ;
- seulement **tant qu'il est administrateur** : rétrogradé ou parti, la clé
  s'arrête d'elle-même ;
- jamais de **validation** : une écriture attend toujours une personne (202
  « needs_approval »). Une application ne peut pas dire « oui » à la place d'un humain.

## 5. Chercher une clé avant de connaître l'organisation

La RLS cache tout tant que l'organisation n'est pas connue… or c'est la clé qui
dit de quelle organisation il s'agit. Solution : une **table d'index**
(empreinte → organisation) à laquelle l'application n'a **aucun droit**, lue par
une seule fonction `SECURITY DEFINER` qui ne renvoie qu'une clé valide. Ce n'est
pas un trou dans la RLS : c'est une porte unique, étroite, et testée.

## 6. Réutiliser au lieu de dupliquer

Un message de l'API passe par **la même route** que l'interface, comme les
tâches planifiées. Les quotas, la règle de deux, les données sensibles et l'audit
ne sont donc pas réécrits, ni oubliés, pour l'API. Une seconde implémentation
serait une seconde surface à sécuriser.

## 7. À retenir

- Clé en en-tête (serveur à serveur) ≠ cookie de session (navigateur).
- On garde l'empreinte, jamais la clé ; on montre un préfixe.
- Une clé a une identité, un périmètre, une date de fin, et se révoque.
- Une application ne valide jamais une écriture à la place d'un humain.
- Une seule route pour l'interface et l'API : une seule sécurité à tenir.
