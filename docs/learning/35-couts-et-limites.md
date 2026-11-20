# 35 — Coûts et limites : savoir ce qu'un agent coûte, et l'arrêter à temps

## 1. Pourquoi c'est un sujet d'IA, pas seulement de comptabilité

Un agent n'a pas un coût fixe. Une même question peut coûter un centime (une
réponse directe) ou plusieurs euros (dix recherches, cinq exécutions de code,
deux images, un sous-agent). Le coût dépend de ce que l'agent **décide** de
faire. Sans limites, une seule personne peut consommer le budget du mois, ou
monopoliser le GPU qui sert les images de tout le monde.

Trois leviers, du plus fin au plus large :
1. **par réponse** : jetons et durée au plus (la boucle d'agent s'arrête) ;
2. **par membre** : budget en euros et quotas d'outils ;
3. **par organisation** : budget en euros, quotas de jetons et d'outils.

## 2. Compter par modèle, calculer à la lecture

Un million de jetons ne coûte pas pareil chez tous les modèles : du simple au
centuple. Avant, Snowfall comptait les jetons par **fournisseur** ; maintenant
par **modèle**. C'est la condition pour parler en euros.

Choix important : le prix n'est **pas** figé au moment de l'appel. On garde les
jetons, et on multiplie par le tarif au moment de l'affichage. Avantages :
- un tarif saisi le 20 du mois vaut pour tout le mois ;
- corriger une erreur de tarif corrige tout l'historique affiché ;
- rien à migrer quand un fournisseur change ses prix.

Et **aucun prix intégré** : les tarifs changent souvent, un prix périmé
afficherait de faux euros, avec l'assurance d'un chiffre exact. Un modèle sans
tarif est **signalé** ; il n'est jamais compté au hasard. Un modèle local est
gratuit par défaut (rien à payer à un tiers), mais on peut lui donner un coût
interne (électricité, amortissement du GPU), comme aux images.

## 3. Vérifier avant chaque outil, pas seulement avant la réponse

Vérifier le budget avant de répondre ne suffit pas : la réponse elle-même peut
le dépasser (deux images à 1 € pour un budget restant de 1 €). Le budget est
donc revérifié **avant chaque appel d'outil compté**. Un refus n'arrête pas la
réponse : l'outil répond au modèle « budget atteint, réponds sans moi et dis-le »,
et le modèle termine honnêtement (fiche 34).

Le test le prouve : deux exécutions de code dans la même réponse, budget de
1 €, chaque exécution à 1 € → la première passe, la seconde est refusée, la
réponse suivante est refusée avant de commencer.

## 4. Le plafond de l'organisation ne dépasse jamais celui de la plateforme

La plateforme fixe des plafonds (jetons et durée d'une réponse). Une
organisation peut les **réduire**, jamais les **augmenter** : `min(organisation,
plateforme)`. Un test le vérifie dans les deux sens, et une mutation (prendre la
valeur de l'organisation telle quelle) le fait échouer.

## 5. Ce que chacun voit

- **Le membre** : ses dépenses face à son budget, ses quotas d'outils.
- **L'administrateur** : les totaux de l'organisation, par modèle et par outil.
- **Personne** : de classement des dépenses par personne (risque de
  surveillance des salariés, AIPD).

## 6. À retenir

- Compter la **quantité** (jetons, appels), calculer le **prix** à la lecture.
- Un chiffre inconnu se signale, il ne s'invente pas.
- Une limite se vérifie au plus près de la dépense (chaque outil).
- Les limites s'emboîtent : réponse ⊂ membre ⊂ organisation ⊂ plateforme.
