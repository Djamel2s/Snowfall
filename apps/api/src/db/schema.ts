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
    tenantPolicy("agents_tenant", table.organizationId),
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
    // Chiffré avec la clé de l'organisation ; NULL = titre par défaut.
    title: text("title"),
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
    content: text("content").notNull(),
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
    tenantPolicy("organization_settings_tenant", table.organizationId),
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
