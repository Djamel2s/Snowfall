# 41 — Brancher n'importe quel fournisseur, sans ouvrir le réseau interne

## 1. Le besoin

Mistral, OpenAI, Anthropic et Google sont intégrés. Mais beaucoup de services
parlent « la langue d'OpenAI » : OpenRouter (des centaines de modèles), Groq,
Together, Azure OpenAI… Un **fournisseur personnalisé**, c'est une adresse
(`https://…/v1`), une clé facultative, et Snowfall lit la liste de ses modèles
(`GET /models`) puis les appelle comme ceux d'OpenAI.

Dans l'interface : panneau Modèles → « Nouveau fournisseur » (administrateurs).
Les modèles sont proposés à toute l'organisation, nommés « Routeur · llama-70b ».

## 2. Le vrai danger : la SSRF

Laisser quelqu'un saisir une adresse que **le serveur** va appeler, c'est le
schéma de la *Server-Side Request Forgery*. Depuis l'intérieur, le serveur voit
ce que l'internaute ne voit pas : la base (`snowfall-postgres`), Keycloak,
l'adresse des métadonnées du cloud (`169.254.169.254`, qui donne des secrets).
Un administrateur d'une organisation pourrait sonder le réseau d'une plateforme
partagée par d'autres.

Les défenses, en couches :
1. **À l'ajout** : HTTPS seulement, pas d'adresse IP privée, pas de `localhost`
   ni de nom sans domaine, pas d'identifiants dans l'adresse, pas de paramètres,
   pas de port inhabituel. Les mêmes règles que les connecteurs MCP.
2. **À chaque appel** : le nom est résolu de nouveau et doit viser une adresse
   publique. Pourquoi ne pas se contenter de l'ajout ? Parce qu'un nom peut
   **changer d'adresse** ensuite (le *DNS rebinding*).
3. **Aucune redirection suivie** : sinon un serveur public répondrait
   « va voir sur 10.0.0.5 » et le client obéirait.
4. **En production, le proxy de sortie** : il ne laisse passer que les domaines
   ouverts par l'exploitant et refuse lui-même les adresses internes. C'est lui
   qui ferme le dernier trou (le DNS qui change *entre* la vérification et la
   connexion).

Les serveurs internes d'une entreprise (vLLM, Ollama) restent possibles, mais
configurés par l'exploitant (fournisseur « local »), jamais depuis l'interface.

## 3. Lier un secret à son contexte (AAD)

La clé est chiffrée avec la clé de l'organisation. La **donnée associée** (AAD)
contient l'organisation, l'identifiant du fournisseur **et son adresse**.
Scénario : un attaquant obtient un accès en écriture à la base et remplace
l'adresse par la sienne pour recevoir la clé au prochain appel. Avec l'adresse
dans l'AAD, le déchiffrement échoue : la clé ne part nulle part.

Le test d'intégration le vérifie. Une leçon au passage : sa première version
modifiait la ligne sans le contexte de l'organisation ; avec la RLS forcée,
**aucune ligne** n'était touchée et le test passait pour de mauvaises raisons.
D'où l'assertion « une ligne modifiée » avant de conclure.

## 4. Un nom de modèle qui porte son fournisseur

Tous les fournisseurs personnalisés sont publiés sous un seul identifiant,
`custom` (liste blanche, quotas, coûts restent simples). Le modèle s'écrit
`<id du fournisseur>/<modèle>`. Le registre ne sert un modèle que si cet id
figure dans la vue **de la personne** : l'id d'une autre organisation donne
« fournisseur indisponible », jamais son serveur. Comme pour les clés (fiche 40),
le cache est rangé par adresse et empreinte de clé.

## 5. Mesurer les tests : les mutations

On casse volontairement le code (retirer la vérification d'adresse, suivre les
redirections, enlever l'adresse de l'AAD…) et on regarde si un test échoue.
Résultat : 13 mutations sur 14 détectées. La manquée (retirer la limite dans la
route) reste couverte par la limite posée en base ; le contrôle de la route sert
surtout à ne pas appeler un serveur pour rien.

## 6. À retenir

1. Une adresse saisie par un utilisateur et appelée par le serveur = SSRF : vérifier à l'ajout, à chaque appel, refuser les redirections, et un proxy de sortie.
2. Un secret chiffré se lie à tout ce qui décide où il part (ici, l'adresse).
3. Un test de sécurité qui passe doit prouver que l'attaque a eu lieu (une ligne modifiée), sinon il ne prouve rien.
