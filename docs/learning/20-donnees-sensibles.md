# Fiche 20 — Protéger les données sensibles avant qu'elles ne partent

> Une base peut être marquée confidentielle. Mais le risque le plus fréquent est
> ailleurs : quelqu'un colle un numéro de sécurité sociale ou parle de la santé
> d'un collègue dans une conversation ordinaire, branchée sur un modèle externe.
> Il faut l'arrêter **avant** l'envoi, sur la plateforme.

## 1. Détecter sans modèle : des règles qui se vérifient

Pour les identifiants, on n'a pas besoin d'IA : ils portent leur **clé de
contrôle**.

| Donnée | Règle | Pourquoi peu de fausses alertes |
|---|---|---|
| N° de sécurité sociale (NIR) | 13 chiffres structurés + clé = 97 − (n mod 97) | un numéro au hasard a 1 chance sur 97 d'avoir la bonne clé |
| IBAN | pays + clé, coupé à la longueur officielle du pays, mod 97 = 1 | idem ; la longueur évite d'avaler « … 189 svp » |
| Carte bancaire | préfixe d'un réseau + clé de Luhn | les numéros de commande ont rarement un préfixe de carte ET une clé juste |

Pour la **santé**, il n'y a pas de clé. La règle est donc : un terme médical
précis (« arrêt maladie », « chimiothérapie », « RQTH ») **et** une personne
visée dans la même phrase (nom, civilité, pronom, rôle). « Le diabète touche
4 millions de Français » passe ; « Julie est diabétique » est détecté.

## 2. Mesurer honnêtement, même une règle

- Un jeu de **mise au point** a servi à écrire les règles : 100 % par construction.
- Un jeu **tenu à l'écart**, écrit après avoir figé les règles : 8/8 détectées,
  1 fausse alerte sur 8. Ce faux positif est un vrai numéro de carte valide
  utilisé comme « numéro de lot » : aucune règle ne peut le savoir, et se tromper
  dans ce sens est prudent.
- Quand une erreur apparaît sur le jeu tenu à l'écart, **on ne corrige pas la
  règle d'après lui** : il ne mesurerait plus rien. Les corrections viennent du
  jeu de mise au point ou de la revue adverse (ex. NIR écrit avec des tirets).

## 3. Que faire quand on détecte ?

Trois options : avertir, bloquer, ou rerouter. Ici :

```
donnée détectée ? ──non──► envoi normal
        │ oui
        ▼
modèle local disponible ? ──oui──► réponse locale, conversation marquée « sensible » pour toujours
        │ non
        ▼
refus avant tout envoi : « Données sensibles détectées (n° de sécurité sociale) »
```

- **Rerouter plutôt qu'avertir** : un avertissement se clique sans le lire.
- **Pour toujours** : la donnée est dans l'historique, donc tout message suivant
  la renverrait. Un déclencheur SQL interdit de retirer le marquage.
- **Réutiliser le confidentiel** : une conversation sensible est traitée comme
  une base confidentielle (pas de traces, pas de web, pas de spécialiste externe,
  pas de mémoire, pas de partage). On ne réinvente pas un second régime.
- **Ne jamais recopier la valeur** : l'audit garde la catégorie, et le titre
  automatique masque les identifiants (« Mon numéro de sécu est ••• »).

## 4. Les limites, à écrire noir sur blanc

Ce filet protège de la **maladresse**, pas d'un utilisateur décidé : un numéro
épelé, une photo de carte Vitale, une opinion religieuse ne sont pas détectés.
Les bases de connaissances qui contiennent des données personnelles doivent
rester marquées confidentielles. Un contrôle n'est utile que si l'on sait ce
qu'il ne fait pas.

## À retenir

1. Avant l'envoi, sur la plateforme : c'est la seule place utile pour ce contrôle.
2. Les clés de contrôle donnent une précision qu'aucun modèle n'offre gratuitement.
3. Un jeu tenu à l'écart ne sert jamais à corriger.
4. Rerouter vers le local, définitivement, en réutilisant le régime confidentiel.
5. Tracer la catégorie, jamais la valeur ; masquer ce qui s'affiche partout.
