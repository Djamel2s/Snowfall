-- Original binaire d'un fichier de compétence : toujours chiffré (comme le reste
-- de la ligne), et borné (2 Mio en clair, soit ≈ 2,8 Mio chiffré en base64url).
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_original_encrypted_check"
  CHECK ("original" IS NULL OR ("original" ~ '^[0-9]+:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length("original") <= 3000000));
