# 38 — Une photo n'est pas anodine : icônes des bases et des connecteurs

## 1. Une fonction simple en apparence

Choisir une photo pour une base de connaissances ou un connecteur ressemble à
un détail d'interface. Pourtant une image venue de l'utilisateur est une
entrée comme une autre : elle peut porter un script, révéler une position GPS,
pister des lecteurs ou alourdir chaque page. Chaque risque a sa parade.

## 2. Ce que le navigateur fait avant l'envoi

La photo n'est jamais envoyée telle quelle. Le navigateur la dessine sur un
canevas de 128 × 128 px, puis la réencode en WebP (ou JPEG pour Safari). Ce
réencodage a deux effets :
- les **métadonnées disparaissent** : EXIF, coordonnées GPS, modèle de
  l'appareil ;
- l'image devient **légère**, quelques kilo-octets, ce qui compte parce qu'elle
  revient dans chaque liste.

128 px suffisent : une icône s'affiche entre 16 et 44 px, et doubler la taille
couvre les écrans haute densité.

## 3. Ce que l'API vérifie quand même

Le navigateur est du côté de l'utilisateur, donc on ne peut pas lui faire
confiance : une requête peut être forgée sans lui. L'API refuse :
- **le SVG**, parce qu'une image vectorielle peut contenir du JavaScript ;
- **une adresse distante** : une image hébergée ailleurs serait téléchargée par
  chaque lecteur, et le site qui l'héberge saurait qui ouvre la liste (pixel de
  pistage) ;
- **un type mensonger** : on lit la *signature binaire* du fichier (les premiers
  octets d'un PNG valent toujours `89 50 4E 47…`), pas l'étiquette annoncée ;
- **une image trop lourde** : 60 000 caractères au plus.

C'est la défense en profondeur : le contrôle côté client sert au confort,
celui côté serveur sert à la sécurité.

## 4. Chiffrée, comme le reste

Une photo peut montrer une personne : c'est une donnée personnelle. Elle est
donc chiffrée avec la clé de l'organisation, comme le nom de la base. Trois
mécanismes travaillent ensemble :
- la base de données **refuse** une valeur qui n'a pas le format chiffré
  (contrainte `CHECK`) : un oubli dans le code échoue au lieu de fuir ;
- l'**inventaire de rotation** des clés liste chaque colonne chiffrée ; un test
  compare cet inventaire aux contraintes de la base. En ajoutant la colonne, le
  test a échoué tout de suite : « knowledge_bases.icon, mcp_servers.icon
  absentes de la rotation ». Ce filet a fonctionné avant même qu'on y pense ;
- l'**AAD** (données associées) lie chaque valeur chiffrée à sa ligne : on ne
  peut pas recopier la photo chiffrée d'une base sur une autre.

## 5. Qui peut la changer

- Une base : ceux qui peuvent la modifier, droit vérifié par la base de données
  elle-même (RLS).
- Un connecteur : un administrateur seulement. Les membres voient la photo,
  sans bouton pour la changer.

Le journal d'audit note « photo posée » ou « photo retirée », jamais l'image.

## 6. Et pour les prompts et les compétences ?

Une icône sert à **reconnaître d'un coup d'œil** une ressource qui revient
souvent et à plusieurs endroits. Les bases apparaissent dans la bibliothèque
et dans le studio de l'agent ; les connecteurs dans leur panneau et dans le
studio. Un prompt, lui, se choisit par son nom dans une
liste de textes, et une compétence par sa description. Une photo y ajouterait
du bruit sans aider à choisir. On garde donc la règle : une fonction n'est
ajoutée que si elle répond à un besoin.

## 7. À retenir

1. Toute donnée venue de l'utilisateur est une entrée à contrôler, même une image.
2. On nettoie côté client pour le confort, on vérifie côté serveur pour la sécurité.
3. Une contrainte en base et un test d'inventaire transforment un oubli en échec visible.
