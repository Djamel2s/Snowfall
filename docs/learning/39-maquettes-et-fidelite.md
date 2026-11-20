# 39 — Maquettes cliquables, et documents qui n'inventent rien

## 1. Une maquette sans Figma

Figma sert surtout à **lire** une maquette (pour la transformer en code), son
accès est réservé et payant, et il sort de l'infrastructure. Pour qu'un agent
**produise** un prototype, on réutilise ce que Snowfall sait déjà faire : un
bloc de code affiché dans un cadre isolé.

Le modèle écrit un bloc ` ```prototype ` : du HTML qui utilise un **kit**
(comme le studio de documents utilise `snowfall_docs`) :
- des classes toutes prêtes : `topbar`, `tabbar`, `card`, `btn primary`,
  `list > item`, `stat`, `switch`… ;
- des attributs qui donnent vie à la maquette : `data-screen` (un écran),
  `data-go` (aller à un écran), `data-open` (ouvrir une fenêtre), `data-tab`,
  `data-toast`, `data-icon`.

Le modèle n'écrit **aucun JavaScript** : le comportement vient du kit. C'est le
même principe que pour les présentations : le modèle décrit, le code garantit
le rendu. Une barre en haut du cadre permet de changer d'écran et de passer du
mobile à l'ordinateur ; la version « ordinateur » est réduite à l'échelle (une
miniature fidèle) plutôt que tassée.

## 2. Exécuter le kit sans exécuter le modèle

Un prototype a besoin de scripts (naviguer, ouvrir une fenêtre). Le HTML du
modèle, lui, peut contenir un script piégé (injection). La solution :
1. le HTML du modèle est placé dans la page comme **donnée** : un bloc JSON,
   avec `<` échappé (`\u003c`), pour qu'un `</script>` écrit par le modèle ne
   puisse pas en sortir ;
2. le moteur du kit lit cette donnée, la **nettoie** (scripts, cadres, objets,
   attributs `onerror`…, liens `javascript:`, animations SVG qui réécrivent un
   lien, ressources externes), puis l'affiche ;
3. tout se passe dans le cadre d'origine opaque, sans réseau (CSP inchangée).

Le test met des pièges dans une maquette et vérifie qu'aucun ne s'exécute,
qu'aucune requête ne part, et que la navigation marche. Deux mutations
(nettoyeur coupé, échappement retiré) font échouer le test : il protège
vraiment.

Leçon d'atelier : en écrivant ces fichiers avec des scripts, une séquence
`\u003c` est devenue un vrai `<`, et un `\b` un caractère invisible. C'est le
test qui l'a vu. Une protection non testée est une hypothèse.

## 3. Le contrôle de fidélité

Mesuré le 17 novembre : un modèle invente des chiffres pour « remplir » un
rapport (délais par gravité, source). Une consigne ne suffit pas. On passe donc
de « demander » à **vérifier** :
- le graphe d'agent rassemble les nombres que le modèle a **reçus** (demande,
  pièces jointes, historique, résultats d'outils) et les remet à l'outil de code ;
- après chaque document produit, on lit ses nombres et on garde ceux qui ne
  viennent pas des sources ni d'une **déduction simple** : total, moyenne,
  écart, part ou évolution en %, changement d'unité (2 700 k€ = 2,7 M€) ;
- l'écart est renvoyé au modèle (« corrige ou dis d'où ils viennent ») et
  affiché à l'utilisateur (« chiffres à vérifier »).

Le réglage s'est fait sur de **vrais documents** de Gemini. La première version
ne trouvait rien : avec trop de déductions permises, presque tout nombre
« s'explique » par hasard (sommes de petits nombres, ×100). Les règles finales :
un petit nombre doit être connu tel quel, un pourcentage doit être une part ou
une évolution, la date du jour compte telle quelle. Résultat sur les documents
réels : les délais inventés sont trouvés, aucun faux positif sur les documents
fidèles. Limite assumée : « 4 postes » passe si « 4,2 » figure dans la demande.

**Mesure du 20 novembre (Gemini 3.5 Flash-Lite, 8 rapports réels)** :
- le contrôle **trouve** les inventions : délais « cibles » par gravité (4 h,
  12 h, 24 h) dans 4 rapports, un « 25,8 % » faux (11/42 = 26,2 %) ;
- un **faux positif** revenait souvent : « les 11 incidents majeurs et
  critiques » (9 + 2). Les sommes de deux nombres connus sont désormais
  admises ; les écarts de petits nombres restent refusés (6 − 2 → « 4 h ») ;
- le modèle **ignore l'alerte**, même placée en tête du résultat et formulée
  « À FAIRE AVANT DE RÉPONDRE » : 0 correction sur 4. Un petit modèle ne
  suit pas une consigne de correction ; c'est donc au **code** d'avertir
  l'utilisateur (au départ : « chiffres à vérifier : 4, 12, 24 » dans le
  détail de l'étape, trop discret).

Correction (20 novembre) : les nombres à vérifier sont gardés **avec le
fichier** (colonne chiffrée, comme son nom et son contenu) et affichés sous sa
carte : « Chiffres à vérifier : 4 h · 25,8 % ». La personne les voit au moment
où elle télécharge le document, même des jours plus tard.

Leçon : un contrôle qui renvoie l'erreur au modèle n'est fiable que si on a
mesuré que le modèle corrige. Sinon, l'avertissement doit atteindre l'humain.

## 4. Un défaut trouvé en mesurant : la réponse tronquée

En testant les maquettes, une réponse s'arrêtait net, notée « réussie ». Cause :
Gemini, surchargé, envoyait une **erreur 503 au milieu du flux**, en JSON brut ;
le lecteur l'ignorait. L'utilisateur aurait reçu une réponse coupée, sans
avertissement. Désormais : une erreur dans le flux est levée, et un flux qui se
termine sans « raison de fin » (Gemini en donne toujours une) est une
interruption. Le test reproduit le flux réel.

## 5. À retenir

1. Pour faire produire quelque chose de beau à un modèle : un kit qu'il décrit, pas du code qu'il invente.
2. Le contenu d'un modèle s'affiche comme une donnée, nettoyée ; seul notre code s'exécute.
3. Ce qu'une consigne n'obtient pas, un contrôle le mesure et le signale.
4. Une « réussite » trop courte est un signal : regarder ce qui a été produit.
