# Politique de l'API Snowfall : chiffrer, déchiffrer et rechiffrer les clés
# d'organisation avec la clé Transit « snowfall », rien d'autre. L'API ne peut
# ni lire, ni exporter, ni faire tourner, ni supprimer la clé.

path "transit/encrypt/snowfall" {
  capabilities = ["update"]
}

path "transit/decrypt/snowfall" {
  capabilities = ["update"]
}

path "transit/rewrap/snowfall" {
  capabilities = ["update"]
}

# Renouvellement de son propre jeton (court, voir le rôle AppRole).
path "auth/token/renew-self" {
  capabilities = ["update"]
}
