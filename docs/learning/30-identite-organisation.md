# 30 — Mettre aux couleurs du client, sans ouvrir de faille

## 1. Pourquoi c'est utile

Une entreprise adopte plus volontiers « son » outil que « Snowfall ». Son logo,
partout, et son nom dans l'en-tête suffisent à ce sentiment.

L'administrateur règle deux choses dans Administration › Identité :
- importer le logo de l'entreprise ;
- ou garder celui de Snowfall, dans une autre couleur.

## 2. Un logo, huit endroits, une seule source

Le logo apparaissait dans huit endroits : le fond, la barre, l'avatar (barre,
réglages, messages), le sélecteur de modèle et l'onglet du navigateur. Tous
lisaient `/logo.png`.

Un petit état partagé, `lib/branding.ts` lu par `useBranding()`, décide de
l'image une fois pour toutes, et chaque endroit l'affiche :
- **logo importé** : adresse versionnée `/api/branding/logo?v=3`. Le
  navigateur peut la garder en cache longtemps, et le numéro change à chaque
  nouveau logo ;
- **sinon** : le logo de Snowfall, recoloré si une couleur est choisie.

L'icône de l'onglet suit : on remplace son `href` dans la page.

## 3. Recolorer sans perdre les nuances

Le logo est un PNG bleu, avec des dégradés et des reflets. Le remplacer par un
aplat rouge le rendrait plat. On travaille plutôt pixel par pixel, en TSL
(teinte, saturation, luminosité) :
- la **luminosité** est gardée : ombres et reflets restent ;
- la **teinte** tourne de l'écart entre le bleu d'origine (204°, mesuré sur
  l'image) et la couleur choisie, si bien que les petites variations de teinte
  du dessin sont conservées ;
- la **saturation** suit celle de la couleur choisie. C'était le défaut de la
  première version : une pastille grise donnait du bleu, puisque seule la
  teinte changeait ;
- les blancs et les gris du dessin ne bougent pas.

Tout se calcule dans le navigateur (un canvas) : le serveur ne stocke qu'une
couleur `#rrggbb`.

## 3 bis. Toute l'interface dans la couleur de l'entreprise

La couleur choisie ne s'applique pas qu'au logo : elle remplace le bleu de toute
l'interface (boutons, liens, sélection, graphiques).

Le bleu est écrit en dur, en des centaines d'endroits du CSS, et `App.css` ne
se modifie pas. On fait donc comme pour le thème clair : un **générateur**
(`scripts/generate-accent-theme.mjs`) lit les feuilles et produit une feuille
de surcharge.
- Chaque bleu ou lavande (teinte 185–265°), y compris les fonds bleu nuit et
  les gris ardoise, est réécrit en
  `hsl(teinte + var(--accent-shift), saturation × var(--accent-saturation),
  même luminosité)`.
- L'application pose ces deux variables sur `<html>`. Sans couleur choisie, il
  n'y a pas d'attribut `data-accent` : aucune règle ne s'applique, et
  l'interface reste exactement celle d'origine.
- La **luminosité** reste la même : un texte lisible le reste.
- Le vert « prêt », l'orange « attention » et le rouge « erreur » ne bougent
  pas. Une alerte doit rester une alerte, même sur un thème rouge.

Deux pièges trouvés en regardant les captures :

1. **Le raccourci `background` remet `background-clip` à zéro.** Le titre
   « Snowfall », un texte en dégradé, est devenu un rectangle. Le générateur
   réapplique maintenant le découpage.
2. **La cascade.** Une règle A met un fond bleu, et une règle B, plus loin, le
   remplace par `transparent`. Réécrire A seulement, avec un sélecteur plus fort,
   la fait passer devant B : des cadres apparaissent autour des avatars. La
   règle retenue : pour chaque propriété touchée, **toutes** ses déclarations
   sont reprises, dans l'ordre d'origine et avec le même sélecteur. L'ordre de la
   cascade est ainsi conservé.

Un troisième piège : la première version n'écartait que les accents vifs, et le
fond restait bleu nuit sous une interface rouge. Pour que l'ambiance entière
suive, les fonds sombres (luminosité de 4 à 10 %) et les gris bleutés sont
recolorés aussi. Seuls le noir pur, le blanc pur et les gris neutres restent
tels quels. Les couleurs écrites en dur à côté d'une `var()` sont converties
elles aussi : c'était l'origine d'un halo bleu resté au centre de l'écran.

Le même défaut de cascade existe d'ailleurs dans le générateur du thème clair,
d'avant ce travail : il est visible en bleu clair, autour des avatars.

## 4. Une image importée est une entrée hostile

Accepter un fichier d'un utilisateur et l'afficher à tous est une surface
d'attaque classique. Les défenses :

| Risque | Défense |
|---|---|
| **SVG** : c'est du XML qui peut contenir du script | refusé |
| **Faux PNG** (du HTML nommé `.png`) | type reconnu par le **contenu** (signature PNG, en-tête JPEG), jamais par le nom ; la base revérifie l'en-tête |
| **Image énorme** (bombe de décompression) | dimensions lues dans l'en-tête avant tout stockage (1 024 px au plus) et poids borné (512 Ko). L'image est d'abord réduite dans le navigateur, et l'utilisateur ne voit jamais ces limites. |
| **Interprétation à l'affichage** | servie avec son type exact, `nosniff` et une CSP `sandbox`, affichée seulement en `<img>` |
| **Qui peut changer ?** | les administrateurs, vérifiés par la route **et** par la RLS. Un membre qui appellerait la base directement est refusé (test). |

## 5. Ce qu'on n'a pas fait, et pourquoi

La page de connexion Keycloak garde le logo de Snowfall. Elle s'affiche
**avant** la connexion, quand on ne sait pas encore de quelle organisation est
la personne. Faire autrement demanderait, par exemple, un sous-domaine par
entreprise. Garder Snowfall à cet endroit rappelle aussi qui fournit le service.
