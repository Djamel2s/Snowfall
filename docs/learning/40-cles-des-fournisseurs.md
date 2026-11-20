# 40 — Qui paie la réponse ? Les clés d'API des fournisseurs

## 1. Le besoin

Jusqu'ici, les clés des fournisseurs (Google, Mistral, Anthropic, OpenAI)
étaient dans le fichier `.env` du serveur : une clé pour toute la plateforme.
On veut maintenant :
- qu'un **administrateur** saisisse la clé de son organisation dans l'interface ;
- qu'un **membre** puisse utiliser **sa** clé, si l'organisation l'autorise.

Un fournisseur de modèles n'est pas un connecteur : un connecteur donne des
**outils** à l'agent, un fournisseur lui donne son **cerveau**. D'où une entrée
à part, « Modèles », au même format que les connecteurs (liste, fiche, une
action principale, bloc administrateur).

## 2. Et les abonnements Claude ou ChatGPT ?

Un abonnement grand public (Claude Pro, ChatGPT Plus) n'est pas une clé d'API :
- **Anthropic l'interdit** : une application tierce ne peut pas proposer la
  connexion avec un compte Claude, ni faire passer des requêtes par l'abonnement
  de ses utilisateurs ; les développeurs utilisent une clé d'API ;
- **OpenAI** propose « Sign in with ChatGPT », mais pour des applications
  partenaires (une application hébergée doit en faire la demande) ;
- surtout : un abonnement grand public relève de conditions **grand public**.
  Les données de l'entreprise passeraient par le compte personnel d'un salarié,
  sans contrat de sous-traitance. Pour une cible certifiable, c'est non.

## 3. Trois niveaux de clé, une règle de priorité

Pour chaque fournisseur, la clé qui sert une réponse est :
1. **la clé personnelle** du membre, si l'organisation l'autorise ;
2. sinon **la clé de l'organisation** ;
3. sinon **la clé de la plateforme** (`.env`).

Le registre des modèles était global. Il devient une **vue par personne**
(`modelsFor(user)`) : la même interface (catalogue, modèles autorisés, outils),
mais calculée avec les clés de cette personne. On passe la vue explicitement à
chaque endroit qui appelle un modèle, plutôt qu'un contexte implicite : un
oubli donne « fournisseur indisponible », jamais la clé de quelqu'un d'autre.

Piège classique : les **caches**. Le registre garde en mémoire les modèles
créés et les catalogues. Si la clé de cache est « openai:gpt », la clé d'Alice
servirait à Bob. La clé de cache contient donc l'**empreinte** de la clé d'API
(un hachage SHA-256, jamais la clé) : une clé ne sert qu'à elle-même. Une
mutation (cache sans empreinte) fait échouer le test « deux personnes, deux clés ».

## 4. Un secret qu'on ne revoit jamais

- **Chiffré** avec la clé de l'organisation. La donnée associée (AAD) lie le
  chiffré à l'organisation, au membre et au fournisseur : copié dans une autre
  ligne, il ne se déchiffre plus. La base **refuse** une valeur en clair
  (contrainte de format), et la rotation des clés couvre les deux tables.
- **RLS** : une clé personnelle n'est lisible que par son propriétaire, pas même
  par un administrateur.
- **Écriture seule** : l'API ne renvoie que les 4 derniers caractères
  (« ••••1234 »), le journal d'audit ni la clé ni ces caractères, et la page
  efface le champ après l'envoi.
- **Vérifiée** auprès du fournisseur avant d'être gardée (on liste ses modèles),
  10 fois par minute au plus : sinon Snowfall deviendrait un banc d'essai de
  clés volées.
- **Adresse officielle** : une clé saisie dans l'interface n'est jamais envoyée
  à l'adresse configurée pour la plateforme (un proxy, par exemple).

## 5. Qui paie ?

Une réponse servie par une clé personnelle est payée par le membre : elle n'est
**ni plafonnée ni comptée** dans les quotas et budgets de l'organisation
(`billingFor` → « personal »). La liste blanche des fournisseurs et la règle
« données confidentielles → modèle local » s'appliquent toujours.

Le risque, c'est la conformité : une clé personnelle envoie les données sous le
contrat du membre. D'où des clés personnelles **désactivées par défaut**,
autorisées fournisseur par fournisseur par un administrateur (décision tracée),
et retirées aussitôt (cache de 5 s vidé à chaque changement). L'AIPD l'indique.

## 6. Mesurer, encore : le contrôle de fidélité avec un vrai modèle

Mesuré le 20 novembre sur 8 rapports réels (Gemini 3.5 Flash-Lite) : le
contrôle trouve les inventions (délais « cibles » 4 h, 12 h, 24 h ; un « 25,8 % »
faux), corrige un faux positif fréquent (« 11 incidents majeurs et critiques »
= 9 + 2), mais le modèle **ignore l'alerte**, même placée en tête : 0 correction
sur 4. L'avertissement doit donc atteindre l'humain (fiche 39 § 3).

## 7. À retenir

1. Un abonnement grand public n'est pas une clé d'API : conditions, contrat et données ne sont pas les mêmes.
2. Un cache partagé entre personnes est rangé par empreinte du secret, jamais par simple nom.
3. Un secret saisi dans une interface : chiffré, lié à son contexte, jamais réaffiché ni journalisé.
4. Ce qui sort du contrat de l'organisation est désactivé par défaut et décidé par elle.
