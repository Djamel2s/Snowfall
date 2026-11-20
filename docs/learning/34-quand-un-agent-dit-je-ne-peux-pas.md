# 34 — Quand un agent dit « je ne peux pas » alors qu'il a les outils

## 1. Le cas

On demande : « cherche les bonnes pratiques de sécurité sur internet, fais-en
un PDF avec deux images d'aliens qui dansent ». L'agent cherche trois fois,
crée deux images, lance trois fois du code… puis répond qu'il « ne dispose pas
d'outil pour générer un PDF ».

Faux, et pourtant presque rien n'avait marché. Trois causes s'empilaient :

1. **La recherche n'avait rien renvoyé.** SearXNG interroge des moteurs publics.
   Quand l'un refuse (CAPTCHA, « too many requests »), SearXNG le **suspend** :
   1 h, et 24 h pour un CAPTCHA. Quelques refus, et tous les moteurs étaient
   coupés. Indice : des recherches de 0,1 s.
2. **Le code ne voyait pas les images.** `run_code` ne recevait que les pièces
   jointes envoyées par l'utilisateur, pas les fichiers créés par l'agent. Et
   les deux images portaient le même nom, `image.png`.
3. **Aucune bibliothèque PDF** dans le bac à sable.

## 2. Pourquoi le modèle « ment »

Un modèle qui échoue tend à donner une explication **générale et rassurante**
(« je n'ai pas cet outil ») plutôt que la vraie, plus précise (« la recherche n'a
rien donné, le code a échoué »). Ce n'est pas de la malveillance : c'est le
texte le plus probable dans ce contexte.

Deux remèdes, qui se complètent :
- **Une règle explicite** dans la consigne de la plateforme : dire quel outil a
  échoué et pourquoi, ne jamais prétendre ne pas avoir un outil dont on dispose,
  corriger puis réessayer quand l'erreur le permet.
- **Des résultats d'outils clairs** : « Aucun résultat pour cette recherche »
  plutôt qu'une liste vide, et un nom de fichier utilisable dans le message
  (« image-1.png : passe ce nom dans files de run_code »). Le modèle s'appuie
  sur ce que disent les outils : un outil bavard au bon endroit vaut mieux
  qu'une longue consigne.

Et l'interface ne doit pas cacher l'échec : la ligne de recherche affiche
maintenant « Aucun résultat ».

## 3. Ouvrir un accès sans ouvrir une fuite

Donner au code les fichiers produits, c'est élargir ce qu'il peut lire. On garde
les règles des pièces jointes :
- seulement les fichiers de **cette** conversation ;
- **deux barrières** indépendantes : la liste filtre la conversation, et la
  lecture la filtre à nouveau (sans compter la RLS en base) ;
- une pièce jointe de l'utilisateur l'emporte sur un fichier produit de même nom ;
- une exécution qui a lu un fichier compte comme « a lu une donnée privée et non
  fiable » (règle de deux).

Le test de mutation l'a montré : casser une seule barrière ne crée pas de fuite.
Il faut casser les deux, et le test échoue alors. C'est exactement ce qu'on
attend d'une défense en profondeur.

## 4. Ajouter une bibliothèque dans un bac à sable

fpdf2 : pur Python, petite, version d'au moins 14 jours, empreinte vérifiée à
l'installation. Après l'ajout, on relance la **batterie d'attaques** du bac à
sable (réseau, fichiers, processus…) : 27 contrôles, tous bloqués. Une
bibliothèque de plus, c'est du code de plus dans la zone où tourne le code du
modèle : on revérifie l'enclos à chaque ajout.

## 5. À retenir

- Quand un agent dit « je ne peux pas », regarde l'**activité** : quel outil a
  tourné, combien de temps, avec quel résultat.
- Un outil qui ne renvoie rien doit le **dire**, au modèle comme à l'écran.
- Chaque nouvel accès donné à un outil se teste par le chemin d'attaque
  (« et depuis une autre conversation ? »).
