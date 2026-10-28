---
name: Évaluer une violation de données
description: Conduire la réponse à une violation de données personnelles : actions immédiates, qualification du risque, notification CNIL (72 h) et information des personnes.
---

# Évaluer une violation de données (articles 33 et 34)

## 1. Actions immédiates (dans l'heure)
- Contenir : couper l'accès, révoquer les identifiants, isoler la machine, demander la suppression d'un envoi par erreur.
- Préserver les preuves (journaux) ; prévenir le DPO et la sécurité informatique.
- Noter l'heure à laquelle l'organisation **a pris connaissance** de la violation : le délai de 72 h part de là.

## 2. Qualifier
- Type : **confidentialité** (accès ou divulgation non autorisés), **intégrité** (altération), **disponibilité** (perte, destruction, rançongiciel).
- Données : catégories, volume, personnes concernées (salariés, clients, mineurs ?), données sensibles (santé, données bancaires, identifiants, documents d'identité) ?
- Données **chiffrées** avec un algorithme sûr et une clé non compromise ? (réduit fortement le risque)
- Conséquences possibles pour les personnes : usurpation d'identité, fraude, discrimination, atteinte à la réputation, perte de contrôle.

## 3. Décider (le DPO valide)
| Risque pour les personnes | Registre interne (art. 33.5) | Notification CNIL (art. 33) | Information des personnes (art. 34) |
|---|---|---|---|
| Peu probable | Oui | Non (justifier dans le registre) | Non |
| Risque | Oui | **Oui, dans les 72 h** | Non |
| Risque élevé | Oui | **Oui, dans les 72 h** | **Oui, dans les meilleurs délais** |
- Toute violation est inscrite au registre interne, même sans notification.
- Notification en retard (plus de 72 h) : possible, mais avec les motifs du retard. Elle peut se faire en plusieurs fois si les informations ne sont pas toutes disponibles.
- Information des personnes non requise (art. 34.3) si : données rendues incompréhensibles (chiffrement), risque élevé neutralisé par des mesures ultérieures, ou efforts disproportionnés (communication publique alors).

## 4. Contenu de la notification (art. 33.3)
a) nature de la violation, catégories et nombre approximatif de personnes et d'enregistrements ; b) coordonnées du DPO ; c) conséquences probables ; d) mesures prises ou envisagées. Téléservice de notification sur le site de la CNIL.

## 5. Rendu
Actions immédiates → qualification → décision proposée (tableau) → projet de notification et, si besoin, de message aux personnes (clair, sans jargon : ce qui s'est passé, les risques, ce que nous faisons, ce qu'ils peuvent faire, un contact).
