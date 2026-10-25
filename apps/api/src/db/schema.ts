import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
  uniqueIndex,
  foreignKey,
  check,
  integer,
  bigint,
  boolean,
  date,
  jsonb,
  primaryKey,
  pgPolicy,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Contexte tenant posé par transaction (set_config(..., true)) côté API.
// En son absence, les politiques RLS ne laissent rien passer.
const currentOrganization = sql`nullif(current_setting('app.organization_id', true), '')::uuid`;
const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`;

/**
 * Bases de connaissances : celles d'un agent sont visibles de toute
 * l'organisation (user_id NULL), celles d'un projet de son seul propriétaire.
 */
function knowledgePolicy(name: string, organizationId: AnyPgColumn, userId: AnyPgColumn) {
  const condition = sql`${organizationId} = ${currentOrganization} AND (${userId} IS NULL OR ${userId} = ${currentUser})`;
  return pgPolicy(name, { as: "permissive", for: "all", to: "public", using: condition, withCheck: condition });
}

function tenantPolicy(
  name: string,
  organizationId: AnyPgColumn,
  userId?: AnyPgColumn,
) {
  const condition = userId
    ? sql`${organizationId} = ${currentOrganization} AND ${userId} = ${currentUser}`
    : sql`${organizationId} = ${currentOrganization}`;

  return pgPolicy(name, {
    as: "permissive",
    for: "all",
    to: "public",
    using: condition,
    withCheck: condition,
  });
}

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // Alias de l'organisation Keycloak dont les membres SSO (Entra ID, Google
    // Workspace…) sont rattachés automatiquement, avec le rôle par défaut.
    ssoAlias: text("sso_alias"),
    ssoDefaultRole: text("sso_default_role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("organizations_sso_alias_idx").on(table.ssoAlias),
    check("organizations_sso_alias_check", sql`${table.ssoAlias} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check("organizations_sso_role_check", sql`${table.ssoDefaultRole} IN ('member', 'reader')`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("users_email_unique").on(table.email),
  ],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("organization_members_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    index("organization_members_user_idx").on(table.userId),
    check(
      "organization_members_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member', 'reader')`,
    ),
  ],
);

export const externalIdentities = pgTable(
  "external_identities",
  {
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("external_identities_issuer_subject_unique").on(
      table.issuer,
      table.subject,
    ),
    uniqueIndex("external_identities_user_idx").on(table.userId),
  ],
);


export const organizationKeys = pgTable.withRLS(
  "organization_keys",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // DEK chiffrée par la KEK (jamais stockée en clair).
    wrappedKey: text("wrapped_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.version] }),
    check("organization_keys_version_check", sql`${table.version} > 0`),
    tenantPolicy("organization_keys_tenant", table.organizationId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 du jeton de session : le jeton lui-même n'est jamais stocké.
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    // Jetons et profil Keycloak chiffrés (AES-256-GCM).
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    idTokenEnc: text("id_token_enc").notNull(),
    profileEnc: text("profile_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Claim "sid" de Keycloak : cible de la déconnexion back-channel.
    idpSessionId: text("idp_session_id"),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
    index("sessions_idp_session_idx").on(table.idpSessionId),
    index("sessions_subject_idx").on(table.subject),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    // Pas de clé étrangère : la trace doit survivre à la suppression du compte.
    actorUserId: uuid("actor_user_id"),
    organizationId: uuid("organization_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    requestId: text("request_id"),
    details: jsonb("details").notNull().default({}),
  },
  (table) => [
    index("audit_events_occurred_idx").on(table.occurredAt),
    index("audit_events_org_occurred_idx").on(table.organizationId, table.occurredAt),
    check(
      "audit_events_outcome_check",
      sql`${table.outcome} IN ('success', 'failure', 'denied')`,
    ),
  ],
);

export const agentProviders = ["mistral", "openai", "anthropic", "google", "local"] as const;

// Agents partagés au sein d'une organisation. Nom, avatar et instructions
// sont chiffrés ensemble (profile_enc) ; seuls fournisseur et modèle restent
// en clair pour le routage.
export const agents = pgTable.withRLS(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    profileEnc: text("profile_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agents_org_idx").on(table.organizationId, table.updatedAt),
    unique("agents_id_org_unique").on(table.id, table.organizationId),
    check(
      "agents_provider_check",
      sql`${table.provider} IN ('mistral', 'openai', 'anthropic', 'google', 'local')`,
    ),
    check("agents_model_check", sql`length(${table.model}) BETWEEN 1 AND 120`),
    // Lecture : son auteur, un administrateur, ou une autorisation (personne, groupe,
    // organisation). Sans utilisateur (tâches système : rotation des clés), l'organisation.
    pgPolicy("agents_read", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`${table.organizationId} = ${currentOrganization} AND (${currentUser} IS NULL OR ${table.createdBy} = ${currentUser} OR snowfall_is_admin() OR snowfall_access('agent', ${table.id}) IS NOT NULL)`,
    }),
    // Écriture : dans l'organisation ; qui peut modifier ou supprimer est vérifié par l'API.
    pgPolicy("agents_insert", { as: "permissive", for: "insert", to: "public", withCheck: sql`${table.organizationId} = ${currentOrganization}` }),
    pgPolicy("agents_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`${table.organizationId} = ${currentOrganization}`,
      withCheck: sql`${table.organizationId} = ${currentOrganization}`,
    }),
    pgPolicy("agents_delete", { as: "permissive", for: "delete", to: "public", using: sql`${table.organizationId} = ${currentOrganization}` }),
  ],
);

export const conversations = pgTable.withRLS(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Clé étrangère composite (agent_id, organization_id) posée en SQL :
    // ON DELETE SET NULL (agent_id) n'est pas exprimable avec Drizzle.
    agentId: uuid("agent_id"),
    // Même principe que agent_id : FK composite ON DELETE SET NULL (project_id) en SQL.
    projectId: uuid("project_id"),
    // Modèle choisi pour une conversation sans agent ; NULL = modèle par défaut.
    modelProvider: text("model_provider"),
    modelId: text("model_id"),
    // Bases de connaissances consultées : celle de l'agent, celle du projet.
    useAgentKnowledge: boolean("use_agent_knowledge").notNull().default(true),
    useProjectKnowledge: boolean("use_project_knowledge").notNull().default(true),
    // Branches : dernier message de la branche affichée (NULL : la plus récente).
    currentLeafId: uuid("current_leaf_id"),
    // Conversation temporaire : hors historique et recherche, sans contenu dans
    // les traces, impossible à partager ; effacée 24 h après sa création.
    temporary: boolean("temporary").notNull().default(false),
    // Chiffré avec la clé de l'organisation ; NULL = titre par défaut.
    title: text("title"),
    // Donnée sensible détectée un jour dans la conversation : modèle local à jamais.
    sensitive: boolean("sensitive").notNull().default(false),
    // Réglages propres à la conversation (priment sur ceux de l'agent) ;
    // NULL = réglage de l'agent ou du fournisseur. Instructions chiffrées.
    creativity: text("creativity"),
    length: text("length"),
    instructions: text("instructions"),
    // Archivée : hors de l'historique, consultable dans « Archivées ».
    archived: boolean("archived").notNull().default(false),
    // Étiquettes de l'utilisateur : liste JSON chiffrée (un libellé peut être parlant).
    tags: text("tags"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("conversations_org_user_updated_idx").on(
      table.organizationId,
      table.userId,
      table.updatedAt,
    ),
    unique("conversations_id_org_user_unique").on(
      table.id,
      table.organizationId,
      table.userId,
    ),
    foreignKey({
      name: "conversations_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [
        organizationMembers.organizationId,
        organizationMembers.userId,
      ],
    }).onDelete("cascade"),
    check(
      "conversations_model_check",
      sql`(${table.modelProvider} IS NULL AND ${table.modelId} IS NULL) OR (
        ${table.modelProvider} IN ('mistral', 'openai', 'anthropic', 'google', 'local')
        AND length(${table.modelId}) BETWEEN 1 AND 120
        AND ${table.agentId} IS NULL)`,
    ),
    tenantPolicy("conversations_owner", table.organizationId, table.userId),
  ],
);

export const messages = pgTable.withRLS(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    // Message précédent dans la même branche (NULL : premier message).
    parentId: uuid("parent_id"),
    // Run qui a produit la réponse : relie un retour 👍👎 à sa trace.
    runId: uuid("run_id"),
    content: text("content").notNull(),
    // Sources citées par une réponse (base de connaissances), JSON chiffré.
    sources: text("sources"),
    // Auteur d'une réponse : « agent:<id> » ou « model:<fournisseur>:<modèle> » (le
    // modèle ou l'agent peut changer en cours de conversation). Aucun contenu.
    author: text("author"),
    // Réponse inachevée (longueur maximale atteinte, ou arrêtée) : elle peut être continuée.
    incomplete: boolean("incomplete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    foreignKey({
      name: "messages_conversation_owner_fk",
      columns: [
        table.conversationId,
        table.organizationId,
        table.userId,
      ],
      foreignColumns: [
        conversations.id,
        conversations.organizationId,
        conversations.userId,
      ],
    }).onDelete("cascade"),
    check("messages_role_check", sql`${table.role} IN ('user', 'assistant')`),
    // Un parent est toujours un message de la MÊME conversation.
    unique("messages_id_conversation_key").on(table.id, table.conversationId),
    foreignKey({
      name: "messages_parent_fk",
      columns: [table.parentId, table.conversationId],
      foreignColumns: [table.id, table.conversationId],
    }).onDelete("cascade"),
    index("messages_parent_idx").on(table.conversationId, table.parentId),
    tenantPolicy("messages_owner", table.organizationId, table.userId),
  ],
);

const providerList = sql.raw(agentProviders.map((provider) => `'${provider}'`).join(", "));

// Réglages d'administration propres à chaque organisation.
export const organizationSettings = pgTable.withRLS(
  "organization_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Fournisseurs LLM que les membres peuvent utiliser (sous-ensemble des
    // fournisseurs configurés sur la plateforme).
    allowedProviders: text("allowed_providers")
      .array()
      .notNull()
      .default(sql`ARRAY[${providerList}]::text[]`),
    // Plafond mensuel de tokens (entrée + sortie) ; NULL = illimité.
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
    // Plafonds mensuels par fournisseur : { "openai": 2000000, ... }.
    providerTokenLimits: jsonb("provider_token_limits").notNull().default({}),
    // Routage automatique (conversations sans agent ni modèle choisi) : {fast, strong}.
    modelRouting: jsonb("model_routing"),
    // Données sensibles détectées : « local » (modèle local ou refus) ou « off ».
    sensitiveData: text("sensitive_data").notNull().default("local"),
    // Pseudonymisation avant un envoi à un fournisseur externe (désactivée par défaut).
    pseudonymize: boolean("pseudonymize").notNull().default(false),
    // Fournisseur qui calcule les embeddings des bases de connaissances.
    // NULL = recherche par mots-clés seulement (rien n'est envoyé à un tiers).
    embeddingProvider: text("embedding_provider"),
    // Import de pages web dans les bases ; liste vide = tout domaine public.
    linksEnabled: boolean("links_enabled").notNull().default(true),
    linkDomains: text("link_domains").array().notNull().default(sql`ARRAY[]::text[]`),
    // Outils d'agent activés pour l'organisation (identifiants inconnus ignorés à la lecture).
    enabledTools: text("enabled_tools")
      .array()
      .notNull()
      .default(sql`ARRAY['search_knowledge', 'save_to_knowledge']::text[]`),
    // Plafonds mensuels d'appels d'outils par catégorie (code, web, mcp) ; absent = illimité.
    toolLimits: jsonb("tool_limits").notNull().default({}),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "organization_settings_providers_check",
      sql`${table.allowedProviders} <@ ARRAY[${providerList}]::text[]`,
    ),
    check(
      "organization_settings_limit_check",
      sql`${table.monthlyTokenLimit} IS NULL OR ${table.monthlyTokenLimit} > 0`,
    ),
    check(
      "organization_settings_provider_limits_check",
      sql`jsonb_typeof(${table.providerTokenLimits}) = 'object'`,
    ),
    check(
      "organization_settings_embedding_check",
      sql`${table.embeddingProvider} IS NULL OR ${table.embeddingProvider} IN ('mistral', 'openai', 'google', 'local')`,
    ),
    check("organization_settings_link_domains_check", sql`cardinality(${table.linkDomains}) <= 200`),
    check("organization_settings_tools_check", sql`cardinality(${table.enabledTools}) <= 50`),
    check("organization_settings_tool_limits_check", sql`jsonb_typeof(${table.toolLimits}) = 'object'`),
    tenantPolicy("organization_settings_tenant", table.organizationId),
  ],
);

// Appels d'outils agrégés par mois, catégorie et membre (quotas des outils :
// l'exécution de code, la recherche web et MCP ont un coût hors des tokens).
export const toolUsage = pgTable.withRLS(
  "tool_usage",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Pas de clé étrangère, comme token_usage : un départ ne remet pas le compteur à zéro.
    userId: uuid("user_id").notNull(),
    meter: text("meter").notNull(),
    period: date("period").notNull(),
    calls: integer("calls").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.period, table.meter, table.userId] }),
    check("tool_usage_meter_check", sql`${table.meter} IN ('code', 'web', 'mcp', 'image')`),
    check("tool_usage_period_check", sql`${table.period} = date_trunc('month', ${table.period})::date`),
    check("tool_usage_calls_check", sql`${table.calls} >= 0`),
    tenantPolicy("tool_usage_tenant", table.organizationId),
  ],
);

// Consommation de tokens agrégée par mois, fournisseur et membre.
export const tokenUsage = pgTable.withRLS(
  "token_usage",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Pas de clé étrangère : la consommation reste comptée même après le
    // départ du membre (sinon supprimer un compte contournerait le quota).
    userId: uuid("user_id").notNull(),
    provider: text("provider").notNull(),
    period: date("period").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.period, table.provider, table.userId] }),
    check("token_usage_provider_check", sql`${table.provider} IN (${providerList}, 'echo')`),
    check("token_usage_period_check", sql`${table.period} = date_trunc('month', ${table.period})::date`),
    check("token_usage_counts_check", sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0`),
    tenantPolicy("token_usage_tenant", table.organizationId),
  ],
);

// Projets personnels : regroupent des conversations. Nom chiffré.
export const projects = pgTable.withRLS(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("projects_org_user_idx").on(table.organizationId, table.userId, table.updatedAt),
    unique("projects_id_org_user_unique").on(table.id, table.organizationId, table.userId),
    foreignKey({
      name: "projects_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
    tenantPolicy("projects_owner", table.organizationId, table.userId),
  ],
);

export const attachmentKinds = ["document", "image"] as const;
export const attachmentMediaTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// Pièces jointes d'une conversation. Nom, contenu et texte extrait chiffrés
// avec la clé de l'organisation.
export const attachments = pgTable.withRLS(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    // NULL tant que le message n'est pas envoyé (purgé après 24 h).
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    extractedText: text("extracted_text"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("attachments_conversation_idx").on(table.conversationId, table.createdAt),
    index("attachments_message_idx").on(table.messageId),
    foreignKey({
      name: "attachments_conversation_owner_fk",
      columns: [table.conversationId, table.organizationId, table.userId],
      foreignColumns: [conversations.id, conversations.organizationId, conversations.userId],
    }).onDelete("cascade"),
    check("attachments_kind_check", sql`${table.kind} IN ('document', 'image')`),
    check(
      "attachments_media_type_check",
      sql.raw(`media_type IN (${attachmentMediaTypes.map((type) => `'${type}'`).join(", ")})`),
    ),
    check("attachments_size_check", sql.raw(`size_bytes BETWEEN 1 AND ${ATTACHMENT_MAX_BYTES}`)),
    tenantPolicy("attachments_owner", table.organizationId, table.userId),
  ],
);

// Préférences d'interface d'un membre (non sensibles, non chiffrées).
export const userPreferences = pgTable.withRLS(
  "user_preferences",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    locale: text("locale"),
    sendOnEnter: boolean("send_on_enter").notNull().default(true),
    reduceMotion: text("reduce_motion").notNull().default("system"),
    // Mémoire : désactivée tant que l'utilisateur ne l'a pas activée.
    memoryEnabled: boolean("memory_enabled").notNull().default(false),
    theme: text("theme").notNull().default("system"),
    // « Qui je suis, comment me répondre » : chiffré (données personnelles).
    instructionsEnc: text("instructions_enc"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    foreignKey({
      name: "user_preferences_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
    check("user_preferences_locale_check", sql`${table.locale} IS NULL OR ${table.locale} IN ('fr', 'en')`),
    check("user_preferences_motion_check", sql`${table.reduceMotion} IN ('system', 'on', 'off')`),
    tenantPolicy("user_preferences_owner", table.organizationId, table.userId),
  ],
);

// Invitations : l'e-mail pré-autorisé est rattaché à la première connexion,
// seulement si Keycloak l'a vérifié.
export const organizationInvitations = pgTable.withRLS(
  "organization_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    invitedBy: uuid("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
  },
  (table) => [
    uniqueIndex("organization_invitations_pending_idx")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} IS NULL`),
    index("organization_invitations_email_idx").on(sql`lower(${table.email})`),
    check("organization_invitations_role_check", sql`${table.role} IN ('admin', 'member', 'reader')`),
    check(
      "organization_invitations_email_check",
      sql`length(${table.email}) BETWEEN 3 AND 254 AND ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
    ),
    tenantPolicy("organization_invitations_tenant", table.organizationId),
  ],
);

// ---- Bases de connaissances ------------------------------------------------
// Une base par agent (partagée dans l'organisation) ou par projet (privée à
// son propriétaire). Noms, URL, contenus, passages et vecteurs sont chiffrés
// avec la clé de l'organisation : la recherche se fait en mémoire après
// déchiffrement, jamais dans la base.

export const KNOWLEDGE_FILE_MAX_BYTES = 25 * 1024 * 1024;

export const knowledgeBases = pgTable.withRLS(
  "knowledge_bases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    agentId: uuid("agent_id"),
    projectId: uuid("project_id"),
    // Propriétaire d'une base de projet ; NULL pour une base d'agent.
    userId: uuid("user_id"),
    // Confidentiel : embeddings et réponses uniquement par un modèle local.
    confidential: boolean("confidential").notNull().default(false),
    // Incrémentée à chaque changement : invalide l'index en mémoire.
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("knowledge_bases_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("knowledge_bases_agent_idx").on(table.agentId),
    uniqueIndex("knowledge_bases_project_idx").on(table.projectId),
    foreignKey({
      name: "knowledge_bases_agent_fk",
      columns: [table.agentId, table.organizationId],
      foreignColumns: [agents.id, agents.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "knowledge_bases_project_fk",
      columns: [table.projectId, table.organizationId, table.userId],
      foreignColumns: [projects.id, projects.organizationId, projects.userId],
    }).onDelete("cascade"),
    check(
      "knowledge_bases_owner_check",
      sql`(${table.agentId} IS NOT NULL AND ${table.projectId} IS NULL AND ${table.userId} IS NULL)
        OR (${table.agentId} IS NULL AND ${table.projectId} IS NOT NULL AND ${table.userId} IS NOT NULL)`,
    ),
    knowledgePolicy("knowledge_bases_tenant", table.organizationId, table.userId),
  ],
);

export const knowledgeSources = pgTable.withRLS(
  "knowledge_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    baseId: uuid("base_id").notNull(),
    // Recopié de la base par trigger (jamais fourni par l'application).
    userId: uuid("user_id"),
    createdBy: uuid("created_by").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    mediaType: text("media_type"),
    sizeBytes: integer("size_bytes").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    content: text("content").notNull(),
    embeddingModel: text("embedding_model"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("knowledge_sources_base_idx").on(table.baseId, table.createdAt),
    index("knowledge_sources_status_idx").on(table.status),
    unique("knowledge_sources_id_org_unique").on(table.id, table.organizationId),
    foreignKey({
      name: "knowledge_sources_base_fk",
      columns: [table.baseId, table.organizationId],
      foreignColumns: [knowledgeBases.id, knowledgeBases.organizationId],
    }).onDelete("cascade"),
    check("knowledge_sources_kind_check", sql`${table.kind} IN ('file', 'link')`),
    check("knowledge_sources_status_check", sql`${table.status} IN ('pending', 'processing', 'ready', 'error')`),
    check("knowledge_sources_error_check", sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[a-z_]{1,40}$'`),
    check("knowledge_sources_media_check", sql`${table.mediaType} IS NULL OR length(${table.mediaType}) BETWEEN 3 AND 120`),
    check("knowledge_sources_size_check", sql.raw(`size_bytes BETWEEN 0 AND ${KNOWLEDGE_FILE_MAX_BYTES}`)),
    check("knowledge_sources_model_check", sql`${table.embeddingModel} IS NULL OR length(${table.embeddingModel}) BETWEEN 3 AND 160`),
    check("knowledge_sources_url_check", sql`(${table.kind} = 'link') = (${table.url} IS NOT NULL)`),
    knowledgePolicy("knowledge_sources_tenant", table.organizationId, table.userId),
  ],
);

export const knowledgeChunks = pgTable.withRLS(
  "knowledge_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    baseId: uuid("base_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    // Recopié de la source par trigger.
    userId: uuid("user_id"),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    // Vecteur float32 chiffré ; NULL si la base est en mots-clés seulement.
    embedding: text("embedding"),
  },
  (table) => [
    index("knowledge_chunks_base_idx").on(table.baseId),
    index("knowledge_chunks_source_idx").on(table.sourceId, table.ordinal),
    foreignKey({
      name: "knowledge_chunks_source_fk",
      columns: [table.sourceId, table.organizationId],
      foreignColumns: [knowledgeSources.id, knowledgeSources.organizationId],
    }).onDelete("cascade"),
    check("knowledge_chunks_ordinal_check", sql`${table.ordinal} >= 0`),
    knowledgePolicy("knowledge_chunks_tenant", table.organizationId, table.userId),
  ],
);

// ---- Exécution durable des agents -------------------------------------------
// Une réponse d'agent est un « run » : il survit à une déconnexion, à une pause
// de validation et au redémarrage du serveur. Tout contenu est chiffré avec la
// clé de l'organisation ; seuls les identifiants et l'état sont en clair.

export const agentRuns = pgTable.withRLS(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    kind: text("kind").notNull(),
    // running : en cours ou à reprendre ; waiting : attend une validation.
    status: text("status").notNull().default("running"),
    // Demande d'origine (message, pièces jointes, modification…), chiffrée.
    request: text("request").notNull(),
    // Avancement pour une reconnexion (texte partiel, étapes, validations), chiffré.
    progress: text("progress"),
    // Instance qui exécute le run, jusqu'à l'expiration de son bail.
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("agent_runs_id_org_user_unique").on(table.id, table.organizationId, table.userId),
    // Une seule réponse active par conversation.
    uniqueIndex("agent_runs_active_idx")
      .on(table.conversationId)
      .where(sql`${table.status} IN ('running', 'waiting')`),
    index("agent_runs_lease_idx").on(table.status, table.leaseUntil),
    foreignKey({
      name: "agent_runs_conversation_fk",
      columns: [table.conversationId, table.organizationId, table.userId],
      foreignColumns: [conversations.id, conversations.organizationId, conversations.userId],
    }).onDelete("cascade"),
    check("agent_runs_kind_check", sql`${table.kind} IN ('message', 'regenerate', 'continue')`),
    check("agent_runs_status_check", sql`${table.status} IN ('running', 'waiting', 'done', 'failed', 'cancelled')`),
    check("agent_runs_lease_owner_check", sql`${table.leaseOwner} IS NULL OR length(${table.leaseOwner}) BETWEEN 1 AND 80`),
    tenantPolicy("agent_runs_tenant", table.organizationId, table.userId),
  ],
);

// Points de reprise LangGraph (état complet du graphe après chaque étape).
export const agentCheckpoints = pgTable.withRLS(
  "agent_checkpoints",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    // Sous-fil d'un sous-agent dans le même run (vide : le run lui-même).
    threadKey: text("thread_key").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    parentId: text("parent_id"),
    checkpoint: text("checkpoint").notNull(),
    metadata: text("metadata").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "agent_checkpoints_pk", columns: [table.runId, table.threadKey, table.checkpointId] }),
    check("agent_checkpoints_thread_key_check", sql`${table.threadKey} ~ '^[A-Za-z0-9_~-]{0,200}$'`),
    foreignKey({
      name: "agent_checkpoints_run_fk",
      columns: [table.runId, table.organizationId, table.userId],
      foreignColumns: [agentRuns.id, agentRuns.organizationId, agentRuns.userId],
    }).onDelete("cascade"),
    check("agent_checkpoints_id_check", sql`length(${table.checkpointId}) BETWEEN 1 AND 64`),
    tenantPolicy("agent_checkpoints_tenant", table.organizationId, table.userId),
  ],
);

// Écritures intermédiaires d'une étape (résultat de chaque appel d'outil) :
// un outil déjà exécuté n'est jamais relancé à la reprise.
export const agentCheckpointWrites = pgTable.withRLS(
  "agent_checkpoint_writes",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    threadKey: text("thread_key").notNull().default(""),
    checkpointId: text("checkpoint_id").notNull(),
    taskId: text("task_id").notNull(),
    idx: integer("idx").notNull(),
    channel: text("channel").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ name: "agent_checkpoint_writes_pk", columns: [table.runId, table.threadKey, table.checkpointId, table.taskId, table.idx] }),
    check("agent_checkpoint_writes_thread_key_check", sql`${table.threadKey} ~ '^[A-Za-z0-9_~-]{0,200}$'`),
    foreignKey({
      name: "agent_checkpoint_writes_run_fk",
      columns: [table.runId, table.organizationId, table.userId],
      foreignColumns: [agentRuns.id, agentRuns.organizationId, agentRuns.userId],
    }).onDelete("cascade"),
    check("agent_checkpoint_writes_task_check", sql`length(${table.taskId}) BETWEEN 1 AND 64`),
    check("agent_checkpoint_writes_channel_check", sql`length(${table.channel}) BETWEEN 1 AND 64`),
    tenantPolicy("agent_checkpoint_writes_tenant", table.organizationId, table.userId),
  ],
);

// ---- Compaction des longues conversations -----------------------------------
// Résumé des échanges anciens, donné au modèle à la place de ces échanges.
// L'historique affiché reste intact ; le résumé est chiffré et suit la
// conversation (effacé avec elle).
export const conversationSummaries = pgTable.withRLS(
  "conversation_summaries",
  {
    conversationId: uuid("conversation_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    // Dernier message couvert par le résumé (les suivants sont donnés tels quels).
    uptoMessageId: uuid("upto_message_id").notNull(),
    coveredMessages: integer("covered_messages").notNull(),
    summary: text("summary").notNull(),
    model: text("model").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "conversation_summaries_conversation_fk",
      columns: [table.conversationId, table.organizationId, table.userId],
      foreignColumns: [conversations.id, conversations.organizationId, conversations.userId],
    }).onDelete("cascade"),
    check("conversation_summaries_covered_check", sql`${table.coveredMessages} > 0`),
    check("conversation_summaries_model_check", sql`length(${table.model}) BETWEEN 1 AND 160`),
    tenantPolicy("conversation_summaries_tenant", table.organizationId, table.userId),
  ],
);

// ---- Fichiers produits par l'interpréteur de code ---------------------------
// Graphiques, CSV… créés par le bac à sable : analysés par l'antivirus, chiffrés,
// rattachés à la réponse qui les a produits (orphelins purgés après 24 h).
export const GENERATED_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const generatedFileMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
] as const;

export const generatedFiles = pgTable.withRLS(
  "generated_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    // Réponse qui l'a produit ; NULL pendant la réponse (purgé après 24 h sinon).
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("generated_files_conversation_idx").on(table.conversationId, table.createdAt),
    index("generated_files_message_idx").on(table.messageId),
    foreignKey({
      name: "generated_files_conversation_owner_fk",
      columns: [table.conversationId, table.organizationId, table.userId],
      foreignColumns: [conversations.id, conversations.organizationId, conversations.userId],
    }).onDelete("cascade"),
    check(
      "generated_files_media_type_check",
      sql.raw(`media_type IN (${generatedFileMediaTypes.map((type) => `'${type}'`).join(", ")})`),
    ),
    check("generated_files_size_check", sql.raw(`size_bytes BETWEEN 1 AND ${GENERATED_FILE_MAX_BYTES}`)),
    tenantPolicy("generated_files_owner", table.organizationId, table.userId),
  ],
);

// ---- Bibliothèque de prompts --------------------------------------------------
// Prompts réutilisables (variables {{nom}}). Nom et contenu chiffrés. Lecture :
// les siens et ceux qu'on lui partage (personne, groupe, organisation ; voir
// resource_grants) ; écriture : l'auteur, ou un éditeur autorisé (vérifié par l'API).
export const prompts = pgTable.withRLS(
  "prompts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("prompts_organization_idx").on(table.organizationId),
    pgPolicy("prompts_read", {
      as: "permissive",
      for: "select",
      to: "public",
      using: sql`${table.organizationId} = ${currentOrganization} AND (${table.userId} = ${currentUser} OR snowfall_access('prompt', ${table.id}) IS NOT NULL)`,
    }),
    tenantPolicy("prompts_owner", table.organizationId, table.userId),
    // Un éditeur autorisé modifie le contenu (jamais l'auteur ni l'organisation).
    pgPolicy("prompts_editor_update", {
      as: "permissive",
      for: "update",
      to: "public",
      using: sql`${table.organizationId} = ${currentOrganization} AND snowfall_access('prompt', ${table.id}) = 'edit'`,
      withCheck: sql`${table.organizationId} = ${currentOrganization}`,
    }),
  ],
);

// ---- Groupes de membres et droits fins ----------------------------------------------
// Groupes (gérés par les administrateurs) et autorisations par agent ou par prompt :
// une personne, un groupe ou toute l'organisation ; lecture ou modification.
// Lecture contrôlée aussi par la RLS des agents et des prompts (snowfall_access).
export const memberGroups = pgTable.withRLS(
  "member_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Chiffré avec la clé de l'organisation.
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("member_groups_organization_idx").on(table.organizationId),
    unique("member_groups_id_org_unique").on(table.id, table.organizationId),
  ],
);

export const memberGroupMembers = pgTable.withRLS(
  "member_group_members",
  {
    groupId: uuid("group_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("member_group_members_user_idx").on(table.organizationId, table.userId),
    foreignKey({
      name: "member_group_members_group_fk",
      columns: [table.groupId, table.organizationId],
      foreignColumns: [memberGroups.id, memberGroups.organizationId],
    }).onDelete("cascade"),
    // Départ de l'organisation : retiré de ses groupes.
    foreignKey({
      name: "member_group_members_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
  ],
);

export const resourceGrants = pgTable.withRLS(
  "resource_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    // organization : toute l'organisation (principal_id NULL).
    principalType: text("principal_type").notNull(),
    principalId: uuid("principal_id"),
    permission: text("permission").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("resource_grants_resource_idx").on(table.organizationId, table.resourceType, table.resourceId),
    index("resource_grants_principal_idx").on(table.organizationId, table.principalType, table.principalId),
    uniqueIndex("resource_grants_unique").on(table.resourceType, table.resourceId, table.principalType, sql`coalesce(${table.principalId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
    check("resource_grants_type_check", sql`${table.resourceType} IN ('agent', 'prompt', 'skill')`),
    check("resource_grants_permission_check", sql`${table.permission} IN ('view', 'edit')`),
    check(
      "resource_grants_principal_check",
      sql`(${table.principalType} = 'organization' AND ${table.principalId} IS NULL) OR (${table.principalType} IN ('user', 'group') AND ${table.principalId} IS NOT NULL)`,
    ),
  ],
);

// ---- Compétences (skills) -------------------------------------------------------------
// Savoir-faire réutilisable par les agents : description (quand s'en servir),
// instructions détaillées, fichiers de référence. Chargés à la demande par
// l'agent (outil use_skill). Tout est chiffré. Lecture (RLS, voir migration) :
// l'auteur, ceux à qui elle est partagée, et ceux qui voient un agent qui l'utilise.
export const skills = pgTable.withRLS(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull(),
    // Confidentielle : réservée aux agents sur modèle local.
    confidential: boolean("confidential").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("skills_organization_idx").on(table.organizationId),
    unique("skills_id_org_unique").on(table.id, table.organizationId),
  ],
);

// Fichiers de référence d'une compétence : seul leur texte extrait est gardé (chiffré).
export const skillFiles = pgTable.withRLS(
  "skill_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    // Propriétaire de la compétence (rotation des clés par membre).
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("skill_files_skill_idx").on(table.skillId),
    foreignKey({
      name: "skill_files_skill_fk",
      columns: [table.skillId, table.organizationId],
      foreignColumns: [skills.id, skills.organizationId],
    }).onDelete("cascade"),
  ],
);

// Historique : une version par changement de description ou d'instructions (ajout seul).
export const skillVersions = pgTable.withRLS(
  "skill_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    // Propriétaire de la compétence (rotation) ; editedBy : auteur du changement.
    userId: uuid("user_id").notNull(),
    editedBy: uuid("edited_by").notNull(),
    version: integer("version").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("skill_versions_unique").on(table.skillId, table.version),
    foreignKey({
      name: "skill_versions_skill_fk",
      columns: [table.skillId, table.organizationId],
      foreignColumns: [skills.id, skills.organizationId],
    }).onDelete("cascade"),
  ],
);

// Compétences confiées à un agent (identifiants seulement, aucun contenu).
export const agentSkills = pgTable.withRLS(
  "agent_skills",
  {
    agentId: uuid("agent_id").notNull(),
    skillId: uuid("skill_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index("agent_skills_skill_idx").on(table.skillId),
    foreignKey({
      name: "agent_skills_agent_fk",
      columns: [table.agentId, table.organizationId],
      foreignColumns: [agents.id, agents.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_skills_skill_fk",
      columns: [table.skillId, table.organizationId],
      foreignColumns: [skills.id, skills.organizationId],
    }).onDelete("cascade"),
  ],
);

// ---- Préréglages de conversation ---------------------------------------------------
// Réglages nommés (créativité, longueur, instructions) réappliqués en un clic.
// Privés : visibles par leur auteur seul. Nom et instructions chiffrés.
export const conversationPresets = pgTable.withRLS(
  "conversation_presets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    creativity: text("creativity"),
    length: text("length"),
    instructions: text("instructions"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("conversation_presets_owner_idx").on(table.organizationId, table.userId),
    foreignKey({
      name: "conversation_presets_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
    tenantPolicy("conversation_presets_owner", table.organizationId, table.userId),
  ],
);

// ---- Connexions personnelles aux serveurs MCP (OAuth) ---------------------------
// Jetons de l'utilisateur pour un serveur MCP en mode OAuth : chiffrés, lisibles
// par lui seul (pas même un administrateur). Effacés avec le serveur ou au départ
// du membre.
export const mcpUserTokens = pgTable.withRLS(
  "mcp_user_tokens",
  {
    serverId: uuid("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.userId] }),
    foreignKey({
      name: "mcp_user_tokens_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
    tenantPolicy("mcp_user_tokens_owner", table.organizationId, table.userId),
  ],
);

// Demandes de connexion en cours : state (haché) et secret PKCE (chiffré),
// à usage unique, 10 minutes.
export const mcpOauthStates = pgTable.withRLS(
  "mcp_oauth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    serverId: uuid("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
    verifier: text("verifier").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("mcp_oauth_states_hash_check", sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: "mcp_oauth_states_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
    tenantPolicy("mcp_oauth_states_owner", table.organizationId, table.userId),
  ],
);

// ---- Mémoire de l'utilisateur ---------------------------------------------------
// Faits courts retenus à sa demande (validation de chaque ajout). Privée :
// seul l'utilisateur la lit, l'administrateur non plus. Contenu chiffré.
export const userMemories = pgTable.withRLS(
  "user_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("user_memories_owner_idx").on(table.organizationId, table.userId, table.createdAt),
    foreignKey({
      name: "user_memories_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [organizationMembers.organizationId, organizationMembers.userId],
    }).onDelete("cascade"),
    tenantPolicy("user_memories_owner", table.organizationId, table.userId),
  ],
);

// ---- Partage interne d'une conversation ---------------------------------------
// Un lien fige un instantané de la branche affichée, lisible par les membres de
// l'organisation jusqu'à son expiration. Jeton : seul son hachage sert à la
// recherche ; le jeton lui-même (pour le recopier), le titre et l'instantané
// sont chiffrés. Lecture : toute l'organisation ; création, suppression : l'auteur.
export const conversationShares = pgTable.withRLS(
  "conversation_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    token: text("token").notNull(),
    title: text("title").notNull(),
    snapshot: text("snapshot").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("conversation_shares_token_idx").on(table.tokenHash),
    index("conversation_shares_conversation_idx").on(table.conversationId),
    foreignKey({
      name: "conversation_shares_conversation_owner_fk",
      columns: [table.conversationId, table.organizationId, table.userId],
      foreignColumns: [conversations.id, conversations.organizationId, conversations.userId],
    }).onDelete("cascade"),
    check("conversation_shares_token_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("conversation_shares_expiry_check", sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '31 days'`),
    pgPolicy("conversation_shares_read", { as: "permissive", for: "select", to: "public", using: sql`${table.organizationId} = ${currentOrganization}` }),
    tenantPolicy("conversation_shares_owner", table.organizationId, table.userId),
  ],
);

// ---- Retour des utilisateurs sur les réponses (👍👎) -------------------------
// Une note par réponse, posée par l'auteur de la conversation ; commentaire
// facultatif, chiffré. La note seule (jamais le commentaire) part vers les traces.
export const messageFeedback = pgTable.withRLS(
  "message_feedback",
  {
    messageId: uuid("message_id").primaryKey(),
    conversationId: uuid("conversation_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "message_feedback_message_fk",
      columns: [table.messageId, table.conversationId],
      foreignColumns: [messages.id, messages.conversationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_feedback_conversation_owner_fk",
      columns: [table.conversationId, table.organizationId, table.userId],
      foreignColumns: [conversations.id, conversations.organizationId, conversations.userId],
    }).onDelete("cascade"),
    check("message_feedback_rating_check", sql`${table.rating} IN (-1, 1)`),
    tenantPolicy("message_feedback_owner", table.organizationId, table.userId),
  ],
);

// ---- Serveurs MCP approuvés par l'organisation ------------------------------
// Ajoutés par un administrateur ; leurs outils ne sont proposés qu'après
// approbation, et seulement tant que leur empreinte (nom, description, schéma)
// n'a pas changé. Adresse, jeton et liste approuvée : chiffrés.
export const mcpServers = pgTable.withRLS(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    // mcp : serveur MCP ; openapi : API décrite par sa spécification (même chaîne d'outils).
    kind: text("kind").notNull().default("mcp"),
    // Spécification OpenAPI fournie par l'administrateur (figée), chiffrée.
    spec: text("spec"),
    // token : un jeton pour toute l'organisation ; oauth : chaque utilisateur avec son compte.
    auth: text("auth").notNull().default("token"),
    token: text("token"),
    // Configuration OAuth (points d'accès découverts, client) : chiffrée.
    oauth: text("oauth"),
    // Outils approuvés : [{ name, description, inputSchema, access, fingerprint }].
    tools: text("tools"),
    status: text("status").notNull().default("pending"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("mcp_servers_organization_idx").on(table.organizationId),
    check("mcp_servers_status_check", sql`${table.status} IN ('pending', 'approved', 'disabled')`),
    check("mcp_servers_kind_check", sql`(${table.kind} = 'mcp' AND ${table.spec} IS NULL) OR (${table.kind} = 'openapi' AND ${table.spec} IS NOT NULL AND ${table.auth} = 'token')`),
    check("mcp_servers_auth_check", sql`(${table.auth} = 'token' AND ${table.oauth} IS NULL) OR (${table.auth} = 'oauth' AND ${table.oauth} IS NOT NULL AND ${table.token} IS NULL)`),
    check("mcp_servers_name_check", sql`length(${table.name}) BETWEEN 1 AND 60`),
    tenantPolicy("mcp_servers_tenant", table.organizationId),
  ],
);

// ---- Qualité des agents : versions et cas d'évaluation ---------------------------
// Versions des instructions d'un agent (modification, amélioration, restauration),
// avec le score mesuré sur ses cas. Instructions chiffrées (comme le profil).
export const agentVersions = pgTable.withRLS(
  "agent_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    version: integer("version").notNull(),
    instructionsEnc: text("instructions_enc").notNull(),
    source: text("source").notNull(),
    // { passed, total, mean } : aucun contenu.
    score: jsonb("score"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("agent_versions_agent_version_unique").on(table.agentId, table.version),
    index("agent_versions_org_agent_idx").on(table.organizationId, table.agentId),
    check("agent_versions_source_check", sql`${table.source} IN ('edit', 'improvement', 'restore')`),
    check("agent_versions_version_check", sql`${table.version} > 0`),
    tenantPolicy("agent_versions_tenant", table.organizationId),
  ],
);

// Cas d'évaluation d'un agent : proposés depuis un 👎 partagé par son auteur
// (question et commentaire, jamais la réponse), puis validés avec un critère.
export const agentEvalCases = pgTable.withRLS(
  "agent_eval_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    status: text("status").notNull(),
    origin: text("origin").notNull(),
    // Message d'origine (un seul cas par réponse notée).
    sourceMessageId: uuid("source_message_id"),
    questionEnc: text("question_enc").notNull(),
    commentEnc: text("comment_enc"),
    rubricEnc: text("rubric_enc"),
    // Cas partagé depuis un 👎 : il suit son auteur (compte supprimé → cas supprimé).
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("agent_eval_cases_source_unique").on(table.agentId, table.sourceMessageId),
    index("agent_eval_cases_org_agent_idx").on(table.organizationId, table.agentId),
    check("agent_eval_cases_status_check", sql`${table.status} IN ('proposed', 'active')`),
    check("agent_eval_cases_origin_check", sql`${table.origin} IN ('feedback', 'manual')`),
    // Un cas actif a toujours un critère.
    check("agent_eval_cases_rubric_check", sql`${table.status} = 'proposed' OR ${table.rubricEnc} IS NOT NULL`),
    tenantPolicy("agent_eval_cases_tenant", table.organizationId),
  ],
);

// ---- Atelier d'entraînement (administrateurs) ------------------------------------
// Exemples étiquetés saisis par les administrateurs (jamais tirés des conversations),
// chacun rangé une fois pour toutes en entraînement ou en test.
export const decisionExamples = pgTable.withRLS(
  "decision_examples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    textEnc: text("text_enc").notNull(),
    label: text("label").notNull(),
    split: text("split").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("decision_examples_org_task_idx").on(table.organizationId, table.task),
    check("decision_examples_task_check", sql`${table.task} IN ('routing')`),
    check("decision_examples_label_check", sql`${table.label} ~ '^[a-z0-9_-]{1,40}$'`),
    check("decision_examples_split_check", sql`${table.split} IN ('train', 'test')`),
    tenantPolicy("decision_examples_tenant", table.organizationId),
  ],
);

// Têtes de décision entraînées : chiffrées, mesurées sur la part de test, une
// seule active par organisation et par tâche.
export const decisionModels = pgTable.withRLS(
  "decision_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    version: integer("version").notNull(),
    headEnc: text("head_enc").notNull(),
    // Matrices de confusion (tête, référence), tailles : aucun texte.
    metrics: jsonb("metrics").notNull(),
    deployable: boolean("deployable").notNull(),
    status: text("status").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => [
    unique("decision_models_version_unique").on(table.organizationId, table.task, table.version),
    check("decision_models_task_check", sql`${table.task} IN ('routing')`),
    check("decision_models_status_check", sql`${table.status} IN ('candidate', 'active', 'retired')`),
    // Seul un modèle déclaré déployable peut devenir actif.
    check("decision_models_active_check", sql`${table.status} <> 'active' OR ${table.deployable}`),
    tenantPolicy("decision_models_tenant", table.organizationId),
  ],
);

// ---- Agents planifiés et déclencheurs ---------------------------------------------
// Une tâche récurrente (chaque jour, chaque semaine) ou déclenchée (document ajouté
// à la base de l'agent), exécutée au nom de son auteur dans SA conversation, par la
// même route qu'un message. Privée : seul son auteur la voit.
export const agentSchedules = pgTable.withRLS(
  "agent_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    nameEnc: text("name_enc").notNull(),
    promptEnc: text("prompt_enc").notNull(),
    kind: text("kind").notNull(),
    cadence: text("cadence"),
    hour: integer("hour"),
    weekday: integer("weekday"),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    // Bail d'exécution : une seule instance à la fois.
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    // Déclencheur : dernier passage, et sources déjà vues.
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    failures: integer("failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agent_schedules_due_idx").on(table.enabled, table.nextRunAt),
    index("agent_schedules_owner_idx").on(table.organizationId, table.userId),
    check("agent_schedules_kind_check", sql`${table.kind} IN ('schedule', 'knowledge')`),
    check(
      "agent_schedules_rule_check",
      sql`(${table.kind} = 'knowledge' AND ${table.cadence} IS NULL) OR (${table.kind} = 'schedule' AND ${table.cadence} IN ('daily', 'weekly') AND ${table.hour} BETWEEN 0 AND 23 AND (${table.cadence} = 'daily' OR ${table.weekday} BETWEEN 0 AND 6))`,
    ),
    check("agent_schedules_status_check", sql`${table.lastStatus} IS NULL OR ${table.lastStatus} IN ('done', 'paused', 'error', 'skipped')`),
    check("agent_schedules_timezone_check", sql`length(${table.timezone}) BETWEEN 1 AND 64`),
    tenantPolicy("agent_schedules_owner", table.organizationId, table.userId),
  ],
);
