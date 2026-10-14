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

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

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
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
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
