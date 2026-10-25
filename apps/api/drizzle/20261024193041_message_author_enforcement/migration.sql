-- Auteur d'une réponse : forme fixe, jamais de contenu libre.
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_check"
  CHECK ("author" IS NULL OR "author" ~ '^(agent:[0-9a-f-]{36}|model:[a-z]+(:[A-Za-z0-9._:/-]{1,120})?)$');
