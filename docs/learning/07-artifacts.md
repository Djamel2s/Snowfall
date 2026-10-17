# Fiche 7 — Les artifacts : exécuter du code écrit par un modèle, sans risque

> Phase 2, outil 2. Afficher une page HTML, une image SVG ou un diagramme à côté
> de la conversation, sans que ce code puisse toucher Snowfall.

## 1. Le besoin

« Fais-moi un tableau de bord », « dessine le schéma de ce processus » : le
modèle écrit du HTML, du SVG ou du Mermaid. Le montrer en code ne suffit pas, on
veut le **voir**. Mais ce code vient d'un modèle, peut-être manipulé (fiche 1) :
c'est du code **non fiable**, qu'on va exécuter dans le navigateur de
l'utilisateur.

## 2. Comment ça marche

1. Le modèle écrit un bloc ` ```html `, ` ```svg ` ou ` ```mermaid ` (le prompt
   système le lui indique).
2. Le bloc affiche un bouton **Aperçu**.
3. Le panneau de droite charge une **iframe isolée**, lui envoie le contenu par
   `postMessage`, et le cadre l'affiche.

## 3. L'isolation, couche par couche

| Couche | Ce qu'elle empêche |
|---|---|
| `sandbox="allow-scripts"` **sans** `allow-same-origin` | le cadre a une **origine opaque** : il ne peut lire ni les cookies, ni le stockage, ni la page Snowfall, ni appeler l'API comme l'utilisateur |
| CSP propre au cadre (`connect-src 'none'`, `img-src data:`, `form-action 'none'`…) | aucun appel réseau, aucune image ou police externe, aucun formulaire : rien ne peut sortir |
| Pas de `allow-popups`, `allow-top-navigation`, `allow-forms`, `allow-modals` | pas de fenêtre, pas de redirection de la page, pas de boîte de dialogue |
| Mode **Aperçu** par défaut | une méta CSP `script-src 'none'` est ajoutée en tête : aucun script ne s'exécute |
| Mode **Exécuter** à la demande | les scripts tournent, mais toujours sans réseau ni accès à Snowfall |
| Le cadre n'écoute que **sa** page parente, une seule fois | une autre page ne peut pas lui faire afficher autre chose |
| CSP de l'interface : `frame-src 'self'` seulement | aucun autre cadre ne peut être intégré |

### On l'a vérifié dans un vrai navigateur

Une page de test a lancé dans le cadre un code qui essaie de lire la page
parente, les cookies, le stockage et d'appeler l'API :

```
Exécuter : {"pageParente":"bloqué","cookies":"bloqué","stockage":"bloqué","reseau":"bloqué"}
Aperçu   : aucun script exécuté
```

Et un SVG contenant un `<script>` s'affiche… sans que le script s'exécute.

## 4. Mermaid : une histoire de débogage

Mermaid (5,5 Mo) est **intégré en ligne** à une page dédiée,
`/artifact/mermaid.html`, générée au build. Le cadre ne charge donc aucun
fichier, et sa CSP n'a besoin d'aucune source externe.

Deux pièges trouvés en route, qui valent d'être retenus :

1. **`String.replace` et les `$`** : pour insérer Mermaid dans la page, on a d'abord
   écrit `html.replace("<body>", "<body><script>" + code + "</script>")`. Or, dans
   un texte de remplacement, JavaScript interprète `$&`, `$'`, `` $` ``. Le code de
   Mermaid en contient 917 : il a été silencieusement abîmé (3,2 Mo au lieu de
   5,5). La parade est de passer une **fonction** : `replace("<body>", () => …)`.
   **Retiens :** quand une chaîne remplacée vient d'ailleurs, passe une fonction.
2. **Les tests ont menti** : le navigateur sans interface, en mode « temps
   virtuel », n'avance pas les minuteries des cadres isolés (ils tournent dans un
   autre processus). Le rendu semblait bloqué alors qu'il fonctionnait. En temps
   réel, par le protocole DevTools, tout s'affichait. **Retiens :** quand un test
   échoue bizarrement, soupçonne aussi l'outil de test.

Mermaid tourne en `securityLevel: "strict"` : les étiquettes des diagrammes sont
nettoyées (DOMPurify), sans HTML ni clics. npm signale une faille de gravité
faible de KaTeX (formules mathématiques), dépendance de Mermaid : elle reste
confinée au cadre isolé.

## 5. Pas encore là

- **React** : il faudrait transpiler le JSX dans le cadre (un compilateur de
  quelques Mo). Ce sera pour une étape suivante.
- **Documents** (Word, PDF générés) : à venir avec l'interpréteur de code.

## 6. Tests

| Test | Ce qu'il prouve |
|---|---|
| [artifacts.test.ts](../../apps/web/tests/artifacts.test.ts) | blocs reconnus (html, svg, mermaid) et seulement eux ; titre de la page |
| Navigateur réel, configuration nginx réelle | isolation complète en mode Exécuter, aucun script en Aperçu, SVG sans script, Mermaid rendu |

## Pour vérifier que tu as compris

1. Pourquoi `allow-same-origin` serait-il catastrophique ici ?
2. À quoi sert `connect-src 'none'` si le cadre ne peut déjà pas lire les cookies ?
3. Pourquoi l'aperçu ouvre-t-il une page sans scripts par défaut ?
4. Quel est le piège de `"…".replace(motif, texte)` quand le texte vient d'ailleurs ?

## Glossaire

- **Origine opaque** : une origine qui n'est égale à aucune autre, pas même à
  elle-même : aucun accès aux données d'un site.
- **CSP** (Content Security Policy) : la liste de ce qu'une page a le droit de
  charger et d'exécuter.
- **COEP** : en-tête qui oblige chaque ressource intégrée à accepter de l'être.

**Prochain outil :** l'interpréteur de code, dans un bac à sable sans réseau.
