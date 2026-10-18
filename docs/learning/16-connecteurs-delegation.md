# Fiche 16 — Agir au nom de quelqu'un, déléguer, marquer

> Phase 4, suite. Un agent devient utile quand il agit sur de vrais outils et
> s'appuie sur des collègues spécialistes. Chaque ouverture pose la même question :
> **au nom de qui** l'agent agit-il, et **avec quelles données** ?

## 1. Le jeton partagé ne suffit pas : OAuth par utilisateur

Avec un jeton unique pour toute l'organisation, quand l'agent crée un ticket
Jira, Jira voit… « le compte Snowfall ». Impossible de savoir qui l'a demandé, et
l'agent peut faire tout ce que ce compte peut faire, même si l'utilisateur n'en
a pas le droit.

Avec OAuth, chaque utilisateur **se connecte avec son compte** :

```
Mon compte → « Se connecter à Jira »
   │  Snowfall crée : state (aléatoire) + secret PKCE (gardé côté serveur)
   ▼
Jira : « Autoriser Snowfall ? » ── oui ──► retour sur /mcp/callback?code=…&state=…
   │  la page renvoie code + state au serveur (même site), puis efface l'adresse
   ▼
Snowfall échange le code + le secret PKCE contre un jeton (pour CE serveur seulement)
```

Les pièces, et pourquoi chacune compte :
- **state** : lie le retour à la personne qui a commencé (personne ne peut vous
  faire « adopter » sa connexion) ; usage unique.
- **PKCE** : un code intercepté ne sert à rien sans le secret, resté sur le serveur.
- **indicateur de ressource** : le jeton n'est valable que pour ce serveur MCP ;
  un serveur malveillant ne peut pas le rejouer ailleurs.
- **vérification de l'émetteur** : on refuse un serveur d'autorisation qui ne se
  présente pas sous le nom attendu (substitution de fournisseur).

Le test a trouvé un vrai défaut : en développement, React exécute deux fois
certains effets ; le code partait deux fois, et le second envoi (state déjà
utilisé) affichait « échec » par-dessus le succès. Une garde suffit — mais il
fallait le voir en vrai navigateur.

## 2. Une API devient des outils (OpenAPI)

Une spécification OpenAPI décrit chaque opération : méthode, chemin, paramètres,
corps. C'est exactement ce dont un modèle a besoin pour appeler un outil (un nom,
une description, un schéma JSON d'arguments). On la traduit donc en outils… et
on la fait passer par **la même chaîne que MCP** : l'admin examine, approuve outil
par outil (empreinte), l'utilisateur valide chaque écriture, la règle de deux
s'applique. Réutiliser une chaîne déjà durcie vaut mieux qu'en écrire une seconde.

Deux pièges propres aux API : un paramètre qui contient `../../admin` (on l'encode,
et l'adresse finale doit rester sur l'hôte déclaré) ; une spécification qui pointe
vers un schéma distant (refusé : rien n'est téléchargé à l'exécution).

## 3. Déléguer à un collègue sans lui donner les clés

Un sous-agent, c'est un appel de modèle dans un appel d'outil. Le danger : que la
délégation serve d'ascenseur (le spécialiste a des outils que l'appelant n'a pas)
ou de tuyau (le confidentiel d'un côté sort par le modèle externe de l'autre). Ici
le spécialiste ne fait que **lire sa base**, ne délègue pas à son tour, et la
plateforme refuse toute consultation qui ferait passer du confidentiel vers un
modèle externe. Sa réponse revient comme une **donnée** balisée.

## 4. Marquer au lieu de seulement baliser

Des balises `<web_page>` entourent le contenu ; un texte long peut faire
« oublier » au modèle qu'il est encore dedans. Le marquage (« datamarking »)
change le texte lui-même : `Ignoreˆlesˆrègles`. Chaque mot porte sa provenance.
Coût : le modèle pourrait recopier les `ˆ` — d'où un contrôle ajouté à **tous**
les cas du banc.

**Retiens :** pour chaque nouvelle capacité, trace le chemin des données (d'où
elles viennent, où elles peuvent aller) et le chemin de l'autorité (au nom de qui
l'action est faite). La plupart des failles d'agents sont un de ces deux chemins
qu'on n'a pas dessiné.

## Pour vérifier que tu as compris

1. Pourquoi le retour OAuth passe-t-il par une page de l'application plutôt que directement par l'API ?
2. Que gagne-t-on à faire passer les connecteurs OpenAPI par l'approbation MCP plutôt que par un circuit à part ?
3. Pourquoi un spécialiste consulté n'a-t-il pas le droit d'écrire, même si l'agent qui le consulte le peut ?
4. Le marquage abîme-t-il la réponse ? Comment le sait-on ?
