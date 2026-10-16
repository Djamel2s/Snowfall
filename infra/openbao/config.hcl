# Snowfall — OpenBao (KMS). Nœud unique à stockage intégré (Raft), TLS
# obligatoire, joignable uniquement depuis le réseau interne. Pour une haute
# disponibilité, ajouter des nœuds au cluster Raft (retry_join).

ui            = false
disable_mlock = true   # conteneur sans swap ; mlock demanderait IPC_LOCK
cluster_name  = "snowfall"
api_addr      = "https://openbao:8200"
cluster_addr  = "https://openbao:8201"

storage "raft" {
  path    = "/openbao/data"
  node_id = "openbao-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file   = "/openbao/tls/server.crt"
  tls_key_file    = "/openbao/tls/server.key"
  tls_min_version = "tls13"
  # Pas d'en-têtes de proxy : l'adresse source est celle du client direct
  # (requise pour les restrictions CIDR des jetons AppRole).
}

# Journal d'audit sur la sortie standard : chaque opération du KMS est
# tracée, valeurs sensibles hachées (HMAC). Déclaré ici (OpenBao 2 refuse
# l'activation par API) : il ne peut pas être désactivé à distance.
audit "file" "stdout" {
  options {
    file_path = "stdout"
  }
}
