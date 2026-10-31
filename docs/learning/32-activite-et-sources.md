# 32 — Montrer ce que fait l'agent, et d'où vient chaque information

## 1. Pourquoi c'est plus qu'un effet visuel

ChatGPT, Claude et LibreChat affichent tous une ligne « Recherche… » pendant
qu'un agent travaille, puis des sources. Ce n'est pas de la décoration : un
agent qui agit sans montrer ce qu'il fait demande une **confiance aveugle**.
Pour une plateforme qui vise la certification, c'est même une exigence de
**traçabilité** : on doit pouvoir dire, pour chaque affirmation, d'où elle vient.

On a donc cherché à faire mieux sur trois points :

1. **La provenance.** Chaque citation sait quelle étape l'a trouvée (« trouvée
   par la recherche « Ballon d'or 2026 vainqueur » »). Chaque étape montre ce
   qu'elle a trouvé, en distinguant ce qui a été **cité** de ce qui a été lu
   puis écarté.
2. **La vérification sans quitter la page.** Au survol d'une citation, on voit
   l'**extrait** lu par l'agent, pas seulement le titre. On vérifie en une
   seconde que la source dit bien ce que la réponse lui fait dire.
3. **La sécurité visible.** Le fil garde les validations que tu as données, les
   actions refusées, et les contenus signalés comme suspects (« l'agent a été
   averti »). Après coup, on sait si une réponse a croisé un contenu piégé.

## 2. Du graphe à l'écran : un événement plus riche

Tout part du nœud « outil » du graphe (LangGraph). Avant, il émettait
`{ id, name, status, summary }`. Il émet maintenant aussi :

- `startedAt` et `endedAt` : la durée de chaque étape ;
- `found` : les **numéros** des sources que l'outil a renvoyées. On les lit
  dans `data`, la partie structurée du résultat (les passages numérotés). Le
  modèle ne peut pas les inventer : ils viennent du registre de citations ;
- `flagged` : le résultat contient l'avertissement d'injection de la plateforme ;
- `approved` : l'action d'écriture a été validée par l'utilisateur.

Le principe : **ce qui est affiché est dérivé de ce qui s'est passé**, jamais
de ce que le modèle raconte. Les phrases (« Lecture de lemonde.fr ») sont
construites à partir du nom de l'outil et de ses données, pas générées par le
modèle. C'est gratuit, instantané, et une page piégée ne peut pas les détourner.

## 3. Garder l'activité, sans garder ce qui a été lu

Avant, les étapes disparaissaient à la fin de la réponse. Elles sont
maintenant enregistrées avec la réponse (`messages.activity`). La question
délicate, c'est **ce qu'on garde**.

On garde des libellés, des numéros de sources, des durées, et un extrait de
280 caractères au plus par source. On ne garde **jamais** le contenu lu (pages,
documents, résultats d'outils). Une conversation qui a lu un contrat de 40
pages ne stocke pas le contrat une seconde fois.

Ensuite, les mêmes règles que pour le reste :

- **chiffrement** avec une AAD liée au message : copiée sur un autre message,
  elle ne se déchiffre pas ;
- **contrainte en base** : une valeur en clair est refusée ;
- **bornes** : 80 étapes, 80 sources ; un texte du web (titre de page) est
  ramené à une ligne, sans caractères de contrôle ;
- **hors des partages et des exports**.

### Le piège évité : la rotation des clés

Chaque colonne chiffrée doit être rechiffrée quand on change de clé. On
l'avait ajoutée à la main… mais rien ne vérifiait qu'on n'en oublie pas une.
Le test de couverture lit maintenant **les contraintes de la base**. Toute
colonne que la base impose chiffrée doit être dans la rotation, et
inversement. La liste à tenir à jour est devenue une propriété vérifiée.

## 4. Les icônes des sites : le détail qui trahit

La solution facile, c'est `<img src="https://www.google.com/s2/favicons?domain=lemonde.fr">`.
C'est ce que font beaucoup d'outils. Mais alors **chaque citation affichée dit
à Google quel site tu lis**. Charger l'icône depuis le site lui-même ne vaut
pas mieux : le site apprend qui lit ses pages, et quand.

Chez nous, c'est **le serveur** qui récupère l'icône :

- par `safeFetch`, comme les liens de la base : adresse publique seulement,
  proxy de sortie, domaines autorisés par l'organisation, 64 Ko au plus ;
- l'image est reconnue **par ses premiers octets** (PNG, ICO, JPEG, GIF,
  WebP). Jamais de SVG : un SVG est du code, il peut contenir un script ;
- elle est servie depuis `/api/favicons/<domaine>` avec `nosniff` et une CSP
  `sandbox` ;
- le cache est **par organisation**. Avec un cache commun, la vitesse de
  réponse révélerait qu'une autre organisation a déjà lu ce site.

Le test d'écran le vérifie : pendant tout le parcours, aucune requête ne part
ailleurs que vers Snowfall. Sans icône, on affiche l'initiale du site sur une
teinte stable, calculée à partir du nom.

## 5. Citations : une grammaire, pas une expression régulière sur le HTML

Les `[1]` du modèle sont reconnus **par l'analyseur Markdown**, comme un nœud
`cite`, pas par une recherche sur le texte affiché. Ainsi :

- `[1](https://…)` reste un lien, et `` `a[1]` `` reste du code ;
- `[1][2]` et `[1, 3]` donnent une seule pastille « lemonde.fr +1 » ;
- une réponse sans sources affiche `[1]` tel quel.

La carte s'ouvre au survol, au focus (clavier) ou au toucher, se ferme avec
Échap, et se place du côté où elle tient. Sur téléphone, elle s'affiche
au-dessus de la saisie. Un piège classique est apparu au test mobile : un
toucher donne le focus (la carte s'ouvre), puis envoie un clic (qui la
refermait). Le clic qui suit immédiatement une ouverture est donc ignoré.

## 6. Lire au passage cité, et signaler une citation

Pour un document de la base, « Lire au passage cité » ouvre dans le panneau
latéral le texte que l'agent a lu, passage par passage. Le passage cité est
surligné et amené à l'écran. On ne télécharge rien, et c'est le texte exact
qu'avait le modèle, pas une mise en page qui pourrait différer. Le passage est
retrouvé par son extrait (espaces et casse ignorés). Si le document a changé
depuis, le panneau le dit au lieu de surligner au mauvais endroit.

« Signaler cette citation » propose deux raisons : *la source ne dit pas ça*,
ou *source peu fiable ou datée*. Le signalement devient un 👎 commenté sur la
réponse (« Citation [1] (Politique de déplacements.pdf) : la source ne dit pas
ça »). Il suit donc le chemin existant : trace, taux de 👍 de l'agent, et, avec
ton accord, un cas d'évaluation pour l'amélioration continue. Pas de nouveau
circuit à sécuriser : on réutilise celui qui l'est déjà.

## 7. Ce qu'on pourrait faire ensuite

- **Comparer deux réponses par leurs sources** (« celle-ci s'appuie sur des
  sources plus récentes »).
- **Date des pages web** dans la carte de la source (quand le site la donne).
