# 29 — Une interface uniforme, et des titres qui résument

## 1. Pourquoi standardiser

Chaque panneau s'était construit seul :
- Agents : une grille de tuiles et des onglets ;
- Connecteurs : des onglets et un encart ;
- Prompts et Compétences : un petit « + » ;
- Projets : un arbre avec la base documentaire repliée dedans.

Pour l'utilisateur, il fallait réapprendre chaque écran. Pour le code, chaque
nouvelle fonction réinventait sa mise en page.

La règle est désormais la même partout, celle de l'historique des conversations :

1. un bouton **« Nouveau … »** ;
2. une **recherche** juste en dessous ;
3. des **sections** titrées (Mes agents, Partagés avec moi, Catalogue…) ;
4. des **lignes** : icône, titre, sous-titre, actions qui apparaissent au survol.

Ces briques vivent dans `components/ui/List.tsx` :
- `PanelNew` et `PanelSearch` (bouton et recherche) ;
- `ListSection`, `ListRow` et `RowAction` (sections, lignes, actions) ;
- `PanelBack` (retour à la liste).

Elles reprennent les classes CSS de l'historique, si bien que le rendu est le
même par construction et non par imitation. Une nouvelle liste, celle des
workflows par exemple, se compose en quelques lignes.

Les catalogues ne sont plus des écrans à part. Ce sont des **sections** de la
liste, filtrées par la même recherche : chercher « contrat » trouve à la fois
ton agent et le modèle « Juriste contrats ».

## 2. Une conversation n'existe qu'au premier message

Avant, « Nouvelle conversation » créait une ligne dans l'historique, même si
l'on n'écrivait rien. LibreChat et ChatGPT ne le font pas.

Deux façons de faire :
- **ne rien créer** avant l'envoi ;
- **créer, mais cacher** tant qu'il n'y a pas de message.

On a choisi la seconde. Joindre un fichier, régler l'agent ou les paramètres
avant d'écrire demande déjà un identifiant de conversation. Tout repousser
aurait obligé à reprendre chacun de ces gestes, avec un risque de régression
partout.

Concrètement :
- le serveur ne liste que les conversations qui ont un message ;
- le client marque la conversation ouverte comme « brouillon » ;
- cliquer de nouveau sur « Nouvelle conversation » reprend ce brouillon au lieu
  d'en ouvrir un second ;
- les brouillons abandonnés s'effacent après 24 h, sous la RLS de leur auteur,
  sauf celui d'une tâche planifiée, qui attend son premier passage.

## 3. Le titre, une petite tâche de LLM bien cadrée

Un titre recopié (« c'est combien le max qu'on peut se faire rembourser pour un
resto… ») est long et se retrouve mal. Une reformulation (« Plafond repas du
midi ») est courte et se cherche bien.

Pour le cadrer :

| Question | Réponse |
|---|---|
| **Quand ?** | En parallèle de la réponse, à partir de la seule question. Le titre est prêt quand la réponse finit, sans attente de plus. Il est enregistré avant l'événement « fin », moment où le client relit les titres. |
| **Quel modèle ?** | Celui de la conversation, avec les mêmes règles : modèle local si donnée sensible, même pseudonymisation. Une petite tâche n'est pas une raison d'envoyer les données ailleurs. |
| **Quelle consigne ?** | Courte et précise : 2 à 6 mots, le sujet et pas la forme (« Résumé du contrat », pas « Demande de résumé »), une ligne seule. |
| **La demande ?** | Balisée comme une donnée, et neutralisée pour qu'elle ne puisse pas refermer sa balise. |
| **La sortie ?** | Jamais prise telle quelle. Nettoyée : une ligne, sans guillemets ni markdown, sans préfixe « Titre : », bornée à 60 caractères, coupée sur un mot. Un bug du nettoyage a été trouvé par son test : « … ». gardait son ». |
| **Et si l'utilisateur renomme ?** | Le titre généré ne remplace que le titre **provisoire**. Si l'utilisateur a renommé la conversation pendant la réponse, son choix est gardé. |
| **Et si ça échoue ?** | Quota ou panne : le titre provisoire reste, et la réponse n'est pas touchée. |

## 4. À retenir

- Uniformiser, c'est **une seule source** pour la mise en page, pas une
  imitation.
- Un catalogue est une section de liste, pas un écran.
- « Ne pas montrer » est parfois plus sûr que « ne pas créer », à condition de
  faire le ménage ensuite.
- Même une micro-tâche de LLM suit les règles des données. Sa sortie est une
  donnée à nettoyer, et elle ne doit jamais écraser un choix humain.
