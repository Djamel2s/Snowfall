import type { PoolClient } from "pg";
import { checkpointAad } from "../agent/checkpointer.js";
import { runAad } from "../agent/runs.js";
import { profileAad } from "../agents/store.js";
import { attachmentAad } from "../attachments/store.js";
import { summaryAad } from "../conversations/compaction.js";
import { conversationFieldAad, feedbackAad, messageAad, messageSourcesAad, titleAad } from "../conversations/store.js";
import type { TenantContext } from "../db/tenant.js";
import { exampleAad, headAad } from "../decision/workshop.js";
import { generatedFileAad } from "../files/generated.js";
import { chunkAad, sourceAad } from "../knowledge/store.js";
import { tokenAad, verifierAad } from "../mcp/connections.js";
import { mcpServerAad, type Field as McpField } from "../mcp/store.js";
import { memoryAad } from "../memory/store.js";
import { projectNameAad } from "../projects/store.js";
import { presetAad } from "../presets/store.js";
import { promptAad } from "../prompts/store.js";
import { caseAad, versionAad } from "../quality/store.js";
import { scheduleAad } from "../schedules/store.js";
import { shareAad } from "../shares/store.js";
import { groupAad } from "../sharing/store.js";
import { skillAad, skillFileAad, skillVersionAad } from "../skills/store.js";
import { instructionsAad } from "../workspace/preferences.js";
import { keyVersionOf, type OrganizationKeyring } from "./keyring.js";

// Inventaire de TOUTES les colonnes chiffrées par la clé d'organisation, avec
// l'AAD de chaque valeur (importée du module qui l'écrit : une seule source de
// vérité). Sert à rechiffrer après une rotation de clé, et à prouver qu'aucune
// valeur n'utilise plus une ancienne version (avant de la retirer).
// Hors inventaire, volontairement : les sessions (clé maîtresse, données de
// quelques heures) et les clés d'organisation elles-mêmes (rotation de la KEK).
//
// Un test vérifie que toute colonne déclarée « chiffrée » en base y figure.

type Row = Record<string, string | number | null>;
/** organization : lignes de l'organisation ; user : lignes d'un membre ; mixed : les deux (user_id NULL ou non). */
type Scope = "organization" | "user" | "mixed";

export type EncryptedTable = {
  table: string;
  scope: Scope;
  /** Colonnes qui identifient la ligne (et servent à l'AAD). */
  keys: string[];
  fields: { column: string; aad: (row: Row, tenant: TenantContext) => string }[];
};

const s = (value: string | number | null | undefined) => String(value ?? "");

export const ENCRYPTED_TABLES: EncryptedTable[] = [
  // ---- Organisation ------------------------------------------------------------
  { table: "agents", scope: "organization", keys: ["id"], fields: [{ column: "profile_enc", aad: (row, t) => profileAad(t.organizationId, s(row.id)) }] },
  { table: "member_groups", scope: "organization", keys: ["id"], fields: [{ column: "name", aad: (row, t) => groupAad(t.organizationId, s(row.id)) }] },
  { table: "agent_versions", scope: "organization", keys: ["id"], fields: [{ column: "instructions_enc", aad: (row, t) => versionAad(t.organizationId, s(row.id)) }] },
  {
    table: "agent_eval_cases",
    scope: "organization",
    keys: ["id"],
    fields: (["question", "comment", "rubric"] as const).map((field) => ({ column: `${field}_enc`, aad: (row: Row, t: TenantContext) => caseAad(t.organizationId, s(row.id), field) })),
  },
  { table: "decision_examples", scope: "organization", keys: ["id"], fields: [{ column: "text_enc", aad: (row, t) => exampleAad(t.organizationId, s(row.id)) }] },
  { table: "decision_models", scope: "organization", keys: ["id"], fields: [{ column: "head_enc", aad: (row, t) => headAad(t.organizationId, s(row.id)) }] },
  {
    table: "mcp_servers",
    scope: "organization",
    keys: ["id"],
    fields: (["url", "token", "tools", "oauth", "spec"] as McpField[]).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => mcpServerAad(t, s(row.id), field) })),
  },
  {
    table: "knowledge_sources",
    scope: "mixed",
    keys: ["id", "base_id"],
    fields: (["name", "url", "content"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => sourceAad(t.organizationId, s(row.base_id), s(row.id), field) })),
  },
  {
    table: "knowledge_chunks",
    scope: "mixed",
    keys: ["id", "source_id"],
    fields: [
      { column: "content", aad: (row, t) => chunkAad(t.organizationId, s(row.source_id), s(row.id), "text") },
      { column: "embedding", aad: (row, t) => chunkAad(t.organizationId, s(row.source_id), s(row.id), "vector") },
    ],
  },
  // ---- Données de chaque membre ---------------------------------------------------
  {
    table: "conversations",
    scope: "user",
    keys: ["id"],
    fields: [
      { column: "title", aad: (row, t) => titleAad(t, s(row.id)) },
      { column: "instructions", aad: (row, t) => conversationFieldAad(t, s(row.id), "instructions") },
      { column: "tags", aad: (row, t) => conversationFieldAad(t, s(row.id), "tags") },
    ],
  },
  {
    table: "conversation_presets",
    scope: "user",
    keys: ["id"],
    fields: (["name", "instructions"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => presetAad(t, s(row.id), field) })),
  },
  {
    table: "messages",
    scope: "user",
    keys: ["id", "conversation_id", "role"],
    fields: [
      { column: "content", aad: (row, t) => messageAad(t, s(row.conversation_id), s(row.id), s(row.role) as Parameters<typeof messageAad>[3]) },
      { column: "sources", aad: (row, t) => messageSourcesAad(t, s(row.conversation_id), s(row.id)) },
    ],
  },
  { table: "message_feedback", scope: "user", keys: ["message_id"], fields: [{ column: "comment", aad: (row, t) => feedbackAad(t, s(row.message_id)) }] },
  { table: "projects", scope: "user", keys: ["id"], fields: [{ column: "name", aad: (row, t) => projectNameAad(t, s(row.id)) }] },
  {
    table: "attachments",
    scope: "user",
    keys: ["id"],
    fields: [
      { column: "name", aad: (row, t) => attachmentAad(t, s(row.id), "name") },
      { column: "content", aad: (row, t) => attachmentAad(t, s(row.id), "content") },
      { column: "extracted_text", aad: (row, t) => attachmentAad(t, s(row.id), "text") },
    ],
  },
  {
    table: "agent_runs",
    scope: "user",
    keys: ["id"],
    fields: (["request", "progress"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => runAad(t, s(row.id), field) })),
  },
  {
    table: "agent_checkpoints",
    scope: "user",
    keys: ["run_id", "thread_key", "checkpoint_id"],
    fields: [
      { column: "checkpoint", aad: (row, t) => checkpointAad(t.organizationId, s(row.run_id), s(row.thread_key), s(row.checkpoint_id)) },
      { column: "metadata", aad: (row, t) => checkpointAad(t.organizationId, s(row.run_id), s(row.thread_key), s(row.checkpoint_id), "metadata") },
    ],
  },
  {
    table: "agent_checkpoint_writes",
    scope: "user",
    keys: ["run_id", "thread_key", "checkpoint_id", "task_id", "idx"],
    fields: [{ column: "value", aad: (row, t) => checkpointAad(t.organizationId, s(row.run_id), s(row.thread_key), s(row.checkpoint_id), s(row.task_id), Number(row.idx)) }],
  },
  { table: "conversation_summaries", scope: "user", keys: ["conversation_id"], fields: [{ column: "summary", aad: (row, t) => summaryAad(t, s(row.conversation_id)) }] },
  {
    table: "generated_files",
    scope: "user",
    keys: ["id"],
    fields: (["name", "content"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => generatedFileAad(t, s(row.id), field) })),
  },
  {
    table: "prompts",
    scope: "user",
    keys: ["id"],
    fields: (["name", "content"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => promptAad(t, s(row.id), field) })),
  },
  {
    table: "skills",
    scope: "user",
    keys: ["id"],
    fields: (["name", "description", "instructions"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => skillAad(t.organizationId, s(row.id), field) })),
  },
  {
    table: "skill_files",
    scope: "user",
    keys: ["id"],
    // « original » : facultatif (NULL ignoré), binaire rechiffré à l'identique.
    fields: (["name", "content", "original"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => skillFileAad(t.organizationId, s(row.id), field) })),
  },
  {
    table: "skill_versions",
    scope: "user",
    keys: ["id"],
    fields: (["description", "instructions"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => skillVersionAad(t.organizationId, s(row.id), field) })),
  },
  { table: "user_memories", scope: "user", keys: ["id"], fields: [{ column: "content", aad: (row, t) => memoryAad(t, s(row.id)) }] },
  { table: "user_preferences", scope: "user", keys: ["user_id"], fields: [{ column: "instructions_enc", aad: (_row, t) => instructionsAad(t) }] },
  {
    table: "mcp_user_tokens",
    scope: "user",
    keys: ["server_id"],
    fields: [
      { column: "access_token", aad: (row, t) => tokenAad(t, s(row.server_id), "access") },
      { column: "refresh_token", aad: (row, t) => tokenAad(t, s(row.server_id), "refresh") },
    ],
  },
  { table: "mcp_oauth_states", scope: "user", keys: ["state_hash"], fields: [{ column: "verifier", aad: (row, t) => verifierAad(t, s(row.state_hash)) }] },
  {
    table: "conversation_shares",
    scope: "user",
    keys: ["id"],
    fields: (["token", "title", "snapshot"] as const).map((field) => ({ column: field, aad: (row: Row, t: TenantContext) => shareAad(t, s(row.id), field) })),
  },
  {
    table: "agent_schedules",
    scope: "user",
    keys: ["id"],
    fields: (["name", "prompt"] as const).map((field) => ({ column: `${field}_enc`, aad: (row: Row, t: TenantContext) => scheduleAad(t.organizationId, s(row.id), field) })),
  },
];

const BATCH = 500;
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Lignes de la table visibles dans le contexte courant (organisation, ou un membre). */
function scopeFilter(target: EncryptedTable, tenant: TenantContext) {
  if (target.scope === "organization") return { sql: "organization_id = $1", params: [tenant.organizationId] };
  if (target.scope === "mixed" && !tenant.userId) return { sql: "organization_id = $1 AND user_id IS NULL", params: [tenant.organizationId] };
  return { sql: "organization_id = $1 AND user_id = $2", params: [tenant.organizationId, tenant.userId] };
}

/** Tables à traiter pour ce contexte : celles de l'organisation (userId vide) ou d'un membre. */
export const tablesFor = (member: boolean) => ENCRYPTED_TABLES.filter((target) => (member ? target.scope !== "organization" : target.scope !== "user"));

/**
 * Rechiffre avec la dernière version de clé toute valeur qui ne l'utilise pas
 * encore. À appeler dans une transaction où le contexte (RLS) est posé. Les
 * valeurs sont déchiffrées et rechiffrées en octets : texte et binaire à l'identique.
 */
export async function reencryptTable(client: PoolClient, keyring: OrganizationKeyring, target: EncryptedTable, tenant: TenantContext, latest: number) {
  const scope = scopeFilter(target, tenant);
  const columns = [...new Set([...target.keys, ...target.fields.map((field) => field.column)])].map(ident).join(", ");
  const order = target.keys.map(ident).join(", ");
  let updated = 0;
  for (let offset = 0; ; offset += BATCH) {
    const rows = (await client.query<Row>(`SELECT ${columns} FROM ${ident(target.table)} WHERE ${scope.sql} ORDER BY ${order} LIMIT ${BATCH} OFFSET ${offset}`, scope.params)).rows;
    for (const row of rows) {
      const changes: [string, string][] = [];
      for (const field of target.fields) {
        const stored = row[field.column];
        if (typeof stored !== "string" || keyVersionOf(stored) === latest) continue;
        const aad = field.aad(row, tenant);
        const bytes = await keyring.decryptBytes(client, tenant.organizationId, stored, aad);
        changes.push([field.column, await keyring.encryptBytes(client, tenant.organizationId, bytes, aad)]);
      }
      if (!changes.length) continue;
      const sets = changes.map(([column], index) => `${ident(column)} = $${index + 1}`).join(", ");
      const where = target.keys.map((key, index) => `${ident(key)} = $${changes.length + index + 1}`).join(" AND ");
      await client.query(`UPDATE ${ident(target.table)} SET ${sets} WHERE ${where} AND ${scope.sql.replace(/\$(\d)/g, (_, n: string) => `$${changes.length + target.keys.length + Number(n)}`)}`, [
        ...changes.map(([, value]) => value),
        ...target.keys.map((key) => row[key]),
        ...scope.params,
      ]);
      updated++;
    }
    if (rows.length < BATCH) return updated;
  }
}

/** Nombre de valeurs encore chiffrées avec une version antérieure à `latest`. */
export async function staleValues(client: PoolClient, target: EncryptedTable, tenant: TenantContext, latest: number) {
  const scope = scopeFilter(target, tenant);
  const counts = target.fields.map((field) => `count(*) FILTER (WHERE ${ident(field.column)} IS NOT NULL AND split_part(${ident(field.column)}, ':', 1)::int < ${Number(latest)})`).join(" + ");
  const result = await client.query<{ stale: string }>(`SELECT (${counts}) AS stale FROM ${ident(target.table)} WHERE ${scope.sql}`, scope.params);
  return Number(result.rows[0]!.stale);
}
