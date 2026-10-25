# Fiche 22 — Rattraper LibreChat sans rien lâcher sur la sécurité

> Quatorze fonctions « de confort » : changer de modèle, thème clair, réglages
> par conversation, continuer, bifurquer, partager finement… Chacune paraît
> anodine. Chacune ouvre pourtant une porte : une consigne de plus envoyée au
> modèle, une copie de données, un droit de plus. Cette fiche montre comment on
> referme chaque porte au moment de l'ouvrir.

## 1. Les paramètres de génération : ce qu'on donne vraiment au modèle

Un modèle de langage choisit chaque mot au hasard, parmi les plus probables.

- **Température** : à 0,1, il prend presque toujours le mot le plus probable
  (réponses stables, factuelles) ; à 0,9, il ose davantage (plus varié, plus de
  risques d'erreur). Dans Snowfall : « Précise » 0,1, « Équilibrée » 0,5,
  « Créative » 0,9.
- **Longueur maximale** (`max_tokens`) : le nombre de *tokens* (morceaux de mots)
  qu'il a le droit d'écrire. « Concise » = 1 000.

Règle de sécurité : **aucun paramètre libre** n'atteint le fournisseur. On
n'accepte que des valeurs d'une liste (vérifiées par l'API et par la base),
traduites côté serveur. Sinon quelqu'un enverrait `temperature: 50` ou un
paramètre inconnu.

Les réglages d'une **conversation** priment sur ceux de l'**agent**. Ses
**consignes** rejoignent le bloc `<user_preferences>` : ce sont des données de
l'utilisateur, pas des ordres de la plateforme. Elles passent les mêmes
contrôles que les instructions personnalisées (donnée sensible, tentative
d'injection), sont chiffrées, et la pseudonymisation les masque.

## 2. Pourquoi une réponse s'arrête : la « raison d'arrêt »

Chaque fournisseur dit pourquoi il a fini : `stop` (il a terminé), `length` /
`max_tokens` / `MAX_TOKENS` (il a atteint la limite), `refusal`, `tool_calls`…
On lit ce champ dans chaque adaptateur et on le traduit en un événement commun
`truncated`. La réponse est alors marquée **inachevée**, comme celle que
l'utilisateur arrête lui-même.

« Continuer » renvoie au modèle la conversation **avec le début de sa réponse**,
puis une consigne : « reprends exactement là où tu t'es arrêté, sans répéter ».
La suite est **ajoutée au même message**. Pourquoi pas une « préremplissage »
(donner le début comme si le modèle l'avait écrit) ? Tous les fournisseurs ne
l'acceptent pas ; la consigne marche partout.

Conséquence technique : un message n'est plus tout à fait immuable. On donne au
rôle de l'application le droit de modifier **deux colonnes seulement**
(`content`, `incomplete`) — c'est le principe du **moindre privilège** appliqué
colonne par colonne.

## 3. Bifurquer et réutiliser : copier sans faire fuir

Bifurquer = créer une nouvelle conversation à partir d'un message. Réutiliser un
fichier = le joindre à une autre conversation. Dans les deux cas on **copie**
(on ne partage pas une ligne entre deux conversations), et la copie est
**rechiffrée** : chaque valeur chiffrée est liée à sa ligne par l'AAD (fiche 8).
Déchiffrer sous l'ancienne identité, rechiffrer sous la nouvelle.

Le piège : une conversation **sensible** (donnée de santé, paie… → modèle local
à vie, fiche 20) qu'on copie dans une conversation ordinaire. La règle : **la
sensibilité suit la donnée**. La copie d'une conversation sensible est sensible ;
un fichier venu d'une conversation sensible rend la cible sensible.

## 4. Comparer deux modèles honnêtement

La comparaison pose la **même question** au second modèle et range sa réponse
comme une nouvelle **version** (le mécanisme des branches). Les deux s'affichent
côte à côte ; on garde l'une, l'autre reste consultable. Pour bien comparer :

- même question, même contexte, mêmes consignes (seul le modèle change) ;
- plusieurs questions, pas une seule (une réponse isolée ne prouve rien) ;
- regarder l'exactitude et les sources avant le style.

Et une limite de sécurité : on ne compare **jamais** avec un modèle externe une
conversation qui doit rester locale. Refus explicite, tracé — pas de bascule
silencieuse qui ferait croire qu'on a comparé.

## 5. Les droits fins : du rôle à la ressource

Jusqu'ici, les droits dépendaient du **rôle** (admin, membre, lecteur : c'est du
RBAC, *role-based access control*). Partager « cet agent avec le groupe
Juridique, en modification », c'est un droit **par ressource** : une liste
d'autorisations (ACL, *access control list*).

```
resource_grants
  ressource : agent 7f3…        destinataire : groupe Juridique   droit : edit
  ressource : prompt a91…       destinataire : toute l'organisation droit : view
```

Le contrôle se fait **deux fois** (défense en profondeur) :

1. l'API vérifie avant d'agir ;
2. la base le refait elle-même grâce à la RLS : la politique de lecture des
   agents appelle `snowfall_access('agent', id)`. Même une requête SQL écrite à
   la main par erreur ne renvoie rien à qui n'a pas de droit.

Deux détails qui comptent :

- Les fonctions appelées par la RLS sont `SECURITY INVOKER` : elles s'exécutent
  avec les droits de l'appelant, donc la RLS s'applique aussi à l'intérieur.
  (`SECURITY DEFINER` les ferait tourner avec les droits du propriétaire.)
- Quand une ressource, un groupe ou un membre disparaît, ses autorisations
  partent avec lui **dans la même transaction**. Sinon, un membre réinvité un an
  plus tard retrouverait des accès oubliés — un classique des audits.

Qui peut quoi :

| | Utiliser | Modifier | Supprimer | Partager |
|---|---|---|---|---|
| Auteur | ✔ | ✔ | ✔ | ✔ |
| Administrateur (agents) | ✔ | ✔ | ✔ | ✔ |
| Autorisé « modification » | ✔ | ✔ | — | — |
| Autorisé « lecture » | ✔ | — | — | — |

## 6. L'interface sous une CSP stricte

La politique de sécurité du contenu interdit le HTML injecté et les styles en
ligne. Conséquences sur nos choix :

- **Coloration du code** : Prism découpe le code en jetons qu'on affiche comme
  des éléments React (jamais `innerHTML`).
- **Formules** : KaTeX écrit du MathML dans un élément réservé.
- **Export image** : pas de bibliothèque de « capture d'écran » (elles injectent
  des styles et des images `data:`) ; on dessine le texte sur un canevas.
- **Export PDF** : l'impression du navigateur, avec une feuille de style dédiée.
- **Thème clair** : un script génère les couleurs claires depuis le thème sombre
  (luminosité inversée, teinte gardée) ; un test échoue si on oublie de le
  régénérer.

## 7. À retenir

- Une fonction de confort est une **surface d'attaque** : se demander à chaque
  fois ce qui part vers le modèle, ce qui est copié, qui gagne un droit.
- **Listes fermées** pour tout ce qui atteint le fournisseur.
- **La sensibilité suit la donnée**, à travers copies et bifurcations.
- **Moindre privilège** jusqu'à la colonne.
- **Défense en profondeur** : l'API décide, la base vérifie.
- Nettoyer les droits **avec** ce qu'ils concernent, jamais « plus tard ».
