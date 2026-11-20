# 42 — Quand le garde-fou crie au loup, et quand le moteur répond n'importe quoi

## 1. Le constat

Question : « qui est Djamel Nafisse ? ». L'agent répond honnêtement « je n'ai rien
trouvé », mais :
- l'activité affiche **« contenu suspect : l'agent a été averti »** ;
- sous la réponse, **6 « sources »**… toutes sur Google Traduction et Stack Overflow.

Deux défauts distincts, aucun ne venait du modèle.

## 2. Le faux positif : nos propres balises

Les résultats d'un outil sont **enveloppés** par la plateforme pour que le modèle
sache que ce sont des données : `<web_results><web_result title="…">…</web_result></web_results>`.
Le détecteur d'injection a un signal « fausse balise » (une page qui écrit
`<system>` ou `</web_results>` pour s'échapper du bloc). Il analysait le résultat
**enveloppe comprise** : il voyait `<web_results>`… que nous venions d'ajouter.
Résultat : **toute** recherche web était déclarée suspecte.

Pourquoi c'est grave alors que « ça ne bloque rien » ? Une alerte qui sonne tout
le temps n'est plus lue : ni par le modèle, ni par l'humain qui voit la carte de
validation. C'est l'**usure de l'alerte** (*alert fatigue*).

Correction : analyser le contenu **sans nos balises**, mais en gardant la valeur
de leurs attributs, car un titre de page vient de l'extérieur et peut contenir
« ignore les instructions ». C'est sûr parce que chaque outil retire déjà ces
mêmes balises du contenu non fiable avant de l'envelopper : celles qui restent
sont forcément les nôtres. Le test vérifie les trois cas : recherche normale
(rien), injection dans un titre (alerte), `<system>` dans un extrait (alerte).

## 3. Le moteur qui répond n'importe quoi

En développement, Brave et Wikipédia limitent vite un poste (« too many
requests »). Il restait DuckDuckGo (rien pour un nom rare) et Bing, qui renvoie
alors des pages sans aucun rapport. Snowfall les numérotait comme sources, et,
la réponse ne citant rien, les affichait toutes.

Correction : un résultat qui ne contient **aucun terme** de la recherche (titre,
extrait ou adresse ; accents, majuscules et pluriels ignorés ; mots vides
retirés) est écarté avant d'être numéroté. Pour un nom rare, l'agent reçoit
« aucun résultat » : la réponse reste honnête et aucune source parasite n'apparaît.
Limite : un résultat qui contient un des mots par hasard passe encore.

## 4. Voir un document sans l'ouvrir

Les documents produits par les agents (Word, PowerPoint, Excel, PDF) ont
maintenant un **aperçu** : leurs pages en **images**. Pourquoi pas le fichier ?
Un PDF peut contenir du JavaScript, un document Office des objets incorporés et
des liens ; une image n'exécute rien. La chaîne :
1. Office → PDF dans le bac à sable (LibreOffice), avec un **script fixe** de la
   plateforme : jamais de code écrit par un modèle ;
2. PDF → PNG dans le service OCR (Poppler), sous un utilisateur dédié ;
3. les deux services n'ont **aucun réseau** ; les pages restent en mémoire, jamais en base.

Détail d'isolation instructif : le service OCR ne peut pas lire les pages qu'il
fait rendre (elles appartiennent à l'utilisateur isolé). C'est voulu ; un petit
lecteur, lancé sous cet utilisateur, les renvoie.

## 5. À retenir

1. Un détecteur qui analyse aussi ce que la plateforme ajoute se déclenche sur lui-même : analyser seulement ce qui vient de l'extérieur.
2. Une alerte permanente est une alerte morte : mesurer aussi les faux positifs.
3. Un moteur de recherche peut répondre « quelque chose » plutôt que « rien » : vérifier la pertinence avant d'en faire une source.
4. Montrer un document non fiable : le rendre en images dans un service isolé, plutôt que de l'ouvrir dans le navigateur.
