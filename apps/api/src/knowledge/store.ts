import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { bytesToVector, contextHeader, vectorToBytes, type IndexedChunk } from "./search.js";

export type KnowledgeOwner = { kind: "agent"; agentId: string } | { kind: "project"; projectId: string };

export type KnowledgeBase = {
  id: string;
  owner: KnowledgeOwner["kind"];
  confidential: boolean;
  revision: number;
};

export type SourceStatus = "pending" | "processing" | "ready" | "error";

export type KnowledgeSource = {
  id: string;
  baseId: string;
  kind: "file" | "link";
  status: SourceStatus;
  errorCode: string | null;
  name: string;
  url: string | null;
  mediaType: string | null;
  size: number;
  chunkCount: number;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChunkInput = { text: string; heading?: string | null; page?: number | null; vector: Float32Array | null };

/** Passage stocké (chiffré) : texte et emplacement dans le document. */
function encodeChunk(chunk: ChunkInput) {
  return JSON.stringify({ v: 1, t: chunk.text, h: chunk.heading ?? null, p: chunk.page ?? null });
}

function decodeChunk(stored: string): { text: string; heading: string | null; page: number | null } {
  if (stored.startsWith('{"v":1')) {
    const value = JSON.parse(stored) as { t: string; h: string | null; p: number | null };
    return { text: value.t, heading: value.h, page: value.p };
  }
  // Passages importés avant la mémorisation des sections.
  return { text: stored, heading: null, page: null };
}

/** Index déchiffré d'une base, gardé en mémoire le temps d'une révision. */
export type LoadedBase = {
  base: KnowledgeBase;
  chunks: IndexedChunk[];
  sources: Map<string, { name: string; url: string | null }>;
};

/** Sources par base, et passages par base (au-delà : refus d'import). */
export const MAX_SOURCES_PER_BASE = 200;
export const MAX_CHUNKS_PER_BASE = 50_000;

export interface KnowledgeStore {
  findBase(tenant: TenantContext, owner: KnowledgeOwner): Promise<KnowledgeBase | null>;
  ensureBase(tenant: TenantContext, owner: KnowledgeOwner): Promise<KnowledgeBase>;
  setConfidential(tenant: TenantContext, baseId: string, confidential: boolean): Promise<KnowledgeBase | null>;
  listSources(tenant: TenantContext, baseId: string): Promise<KnowledgeSource[]>;
  addSource(
    tenant: TenantContext,
    baseId: string,
    input: { kind: "file" | "link"; name: string; url?: string; mediaType: string | null; bytes: Buffer },
  ): Promise<KnowledgeSource>;
  getSource(tenant: TenantContext, sourceId: string): Promise<(KnowledgeSource & { base: KnowledgeBase; agentId: string | null }) | null>;
  sourceContent(tenant: TenantContext, sourceId: string): Promise<{ name: string; url: string | null; mediaType: string | null; bytes: Buffer } | null>;
  /** Contenu récupéré d'un lien : remplace le contenu provisoire et le nom. */
  updateFetched(tenant: TenantContext, sourceId: string, input: { name: string; mediaType: string; bytes: Buffer }): Promise<void>;
  setStatus(tenant: TenantContext, sourceId: string, status: SourceStatus, errorCode?: string | null): Promise<void>;
  replaceChunks(tenant: TenantContext, sourceId: string, chunks: ChunkInput[], embeddingModel: string | null): Promise<boolean>;
  deleteSource(tenant: TenantContext, sourceId: string): Promise<boolean>;
  baseRevision(tenant: TenantContext, baseId: string): Promise<number | null>;
  load(tenant: TenantContext, baseId: string): Promise<LoadedBase | null>;
  /** Imports interrompus (redémarrage) : identifiants seulement. */
  pending(): Promise<{ sourceId: string; organizationId: string; createdBy: string }[]>;
}

export class KnowledgeLimitError extends Error {
  constructor(readonly code: "too_many_sources" | "too_many_chunks") {
    super(code.toUpperCase());
  }
}

// L'AAD lie chaque chiffré à son organisation, sa base et sa ligne.
const sourceAad = (organizationId: string, baseId: string, sourceId: string, field: "name" | "url" | "content") =>
  `knowledge-${field}:${organizationId}:${baseId}:${sourceId}`;
const chunkAad = (organizationId: string, sourceId: string, chunkId: string, field: "text" | "vector") =>
  `knowledge-chunk-${field}:${organizationId}:${sourceId}:${chunkId}`;

type BaseRow = { id: string; agentId: string | null; confidential: boolean; revision: number };
type SourceRow = {
  id: string;
  baseId: string;
  kind: "file" | "link";
  status: SourceStatus;
  errorCode: string | null;
  name: string;
  url: string | null;
  mediaType: string | null;
  size: number;
  chunkCount: number;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
};

const BASE_COLUMNS = `id, agent_id AS "agentId", confidential, revision`;
const sourceColumns = (p = "") => `${p}id, ${p}base_id AS "baseId", ${p}kind, ${p}status, ${p}error_code AS "errorCode",
  ${p}name, ${p}url, ${p}media_type AS "mediaType", ${p}size_bytes AS size, ${p}chunk_count AS "chunkCount",
  ${p}embedding_model AS "embeddingModel", ${p}created_at AS "createdAt", ${p}updated_at AS "updatedAt"`;
const SOURCE_COLUMNS = sourceColumns();

const toBase = (row: BaseRow): KnowledgeBase => ({
  id: row.id,
  owner: row.agentId ? "agent" : "project",
  confidential: row.confidential,
  revision: row.revision,
});

export class PostgresKnowledgeStore implements KnowledgeStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async decryptSource(client: PoolClient, tenant: TenantContext, row: SourceRow): Promise<KnowledgeSource> {
    const open = (value: string, field: "name" | "url") =>
      this.keyring.decrypt(client, tenant.organizationId, value, sourceAad(tenant.organizationId, row.baseId, row.id, field));
    return { ...row, name: await open(row.name, "name"), url: row.url ? await open(row.url, "url") : null };
  }

  private async bump(client: PoolClient, baseId: string) {
    await client.query("UPDATE knowledge_bases SET revision = revision + 1, updated_at = now() WHERE id = $1", [baseId]);
  }

  private async selectBase(client: PoolClient, tenant: TenantContext, owner: KnowledgeOwner) {
    const result = await client.query<BaseRow>(
      owner.kind === "agent"
        ? `SELECT ${BASE_COLUMNS} FROM knowledge_bases WHERE agent_id = $1 AND organization_id = $2`
        : `SELECT ${BASE_COLUMNS} FROM knowledge_bases WHERE project_id = $1 AND organization_id = $2 AND user_id = $3`,
      owner.kind === "agent" ? [owner.agentId, tenant.organizationId] : [owner.projectId, tenant.organizationId, tenant.userId],
    );
    return result.rows[0] ? toBase(result.rows[0]) : null;
  }

  findBase(tenant: TenantContext, owner: KnowledgeOwner) {
    return withTenant(this.pool, tenant, (client) => this.selectBase(client, tenant, owner));
  }

  ensureBase(tenant: TenantContext, owner: KnowledgeOwner) {
    return withTenant(this.pool, tenant, async (client) => {
      const existing = await this.selectBase(client, tenant, owner);
      if (existing) return existing;
      // L'agent ou le projet doit exister (et être visible) : contrôlé ici,
      // puis garanti par les clés étrangères composites.
      const parent =
        owner.kind === "agent"
          ? await client.query("SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2", [owner.agentId, tenant.organizationId])
          : await client.query("SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND user_id = $3", [
              owner.projectId,
              tenant.organizationId,
              tenant.userId,
            ]);
      if (!parent.rowCount) throw new Error(owner.kind === "agent" ? "AGENT_NOT_FOUND" : "PROJECT_NOT_FOUND");

      await client.query(
        `INSERT INTO knowledge_bases (organization_id, agent_id, project_id, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [
          tenant.organizationId,
          owner.kind === "agent" ? owner.agentId : null,
          owner.kind === "project" ? owner.projectId : null,
          owner.kind === "project" ? tenant.userId : null,
        ],
      );
      const created = await this.selectBase(client, tenant, owner);
      if (!created) throw new Error("KNOWLEDGE_BASE_UNAVAILABLE");
      return created;
    });
  }

  setConfidential(tenant: TenantContext, baseId: string, confidential: boolean) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<BaseRow>(
        `UPDATE knowledge_bases SET confidential = $3, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING ${BASE_COLUMNS}`,
        [baseId, tenant.organizationId, confidential],
      );
      return result.rows[0] ? toBase(result.rows[0]) : null;
    });
  }

  listSources(tenant: TenantContext, baseId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<SourceRow>(
        `SELECT ${SOURCE_COLUMNS} FROM knowledge_sources
         WHERE base_id = $1 AND organization_id = $2
         ORDER BY created_at DESC`,
        [baseId, tenant.organizationId],
      );
      const sources: KnowledgeSource[] = [];
      for (const row of result.rows) sources.push(await this.decryptSource(client, tenant, row));
      return sources;
    });
  }

  addSource(
    tenant: TenantContext,
    baseId: string,
    input: { kind: "file" | "link"; name: string; url?: string; mediaType: string | null; bytes: Buffer },
  ) {
    return withTenant(this.pool, tenant, async (client) => {
      // Verrou sur la base : le plafond de sources ne peut pas être dépassé en parallèle.
      const base = await client.query("SELECT 1 FROM knowledge_bases WHERE id = $1 AND organization_id = $2 FOR UPDATE", [
        baseId,
        tenant.organizationId,
      ]);
      if (!base.rowCount) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");
      const count = await client.query<{ count: string }>("SELECT count(*) FROM knowledge_sources WHERE base_id = $1", [baseId]);
      if (Number(count.rows[0]!.count) >= MAX_SOURCES_PER_BASE) throw new KnowledgeLimitError("too_many_sources");

      const id = randomUUID();
      const seal = await this.keyring.sealer(client, tenant.organizationId);
      const aad = (field: "name" | "url" | "content") => sourceAad(tenant.organizationId, baseId, id, field);

      const result = await client.query<SourceRow>(
        `INSERT INTO knowledge_sources
           (id, organization_id, base_id, created_by, kind, media_type, size_bytes, name, url, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${SOURCE_COLUMNS}`,
        [
          id,
          tenant.organizationId,
          baseId,
          tenant.userId,
          input.kind,
          input.mediaType,
          input.bytes.length,
          seal(input.name, aad("name")),
          input.url ? seal(input.url, aad("url")) : null,
          seal(input.bytes, aad("content")),
        ],
      );
      await this.bump(client, baseId);
      return { ...result.rows[0]!, name: input.name, url: input.url ?? null };
    });
  }

  getSource(tenant: TenantContext, sourceId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<SourceRow & { confidential: boolean; revision: number; agentId: string | null }>(
        `SELECT ${sourceColumns("s.")}, b.confidential, b.revision, b.agent_id AS "agentId"
         FROM knowledge_sources s JOIN knowledge_bases b ON b.id = s.base_id
         WHERE s.id = $1 AND s.organization_id = $2`,
        [sourceId, tenant.organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const { confidential, revision, agentId, ...source } = row;
      return {
        ...(await this.decryptSource(client, tenant, source)),
        base: { id: source.baseId, owner: agentId ? "agent" : "project", confidential, revision } as KnowledgeBase,
        agentId,
      };
    });
  }

  sourceContent(tenant: TenantContext, sourceId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ baseId: string; name: string; url: string | null; mediaType: string | null; content: string }>(
        `SELECT base_id AS "baseId", name, url, media_type AS "mediaType", content FROM knowledge_sources
         WHERE id = $1 AND organization_id = $2`,
        [sourceId, tenant.organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const aad = (field: "name" | "url" | "content") => sourceAad(tenant.organizationId, row.baseId, sourceId, field);
      return {
        name: await this.keyring.decrypt(client, tenant.organizationId, row.name, aad("name")),
        url: row.url ? await this.keyring.decrypt(client, tenant.organizationId, row.url, aad("url")) : null,
        mediaType: row.mediaType,
        bytes: await this.keyring.decryptBytes(client, tenant.organizationId, row.content, aad("content")),
      };
    });
  }

  updateFetched(tenant: TenantContext, sourceId: string, input: { name: string; mediaType: string; bytes: Buffer }) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = await client.query<{ baseId: string }>(
        `SELECT base_id AS "baseId" FROM knowledge_sources WHERE id = $1 AND organization_id = $2`,
        [sourceId, tenant.organizationId],
      );
      const baseId = row.rows[0]?.baseId;
      if (!baseId) return;
      const seal = await this.keyring.sealer(client, tenant.organizationId);
      await client.query(
        `UPDATE knowledge_sources SET name = $3, media_type = $4, size_bytes = $5, content = $6, updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [
          sourceId,
          tenant.organizationId,
          seal(input.name, sourceAad(tenant.organizationId, baseId, sourceId, "name")),
          input.mediaType,
          input.bytes.length,
          seal(input.bytes, sourceAad(tenant.organizationId, baseId, sourceId, "content")),
        ],
      );
    });
  }

  setStatus(tenant: TenantContext, sourceId: string, status: SourceStatus, errorCode: string | null = null) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ baseId: string }>(
        `UPDATE knowledge_sources SET status = $3, error_code = $4, updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING base_id AS "baseId"`,
        [sourceId, tenant.organizationId, status, errorCode],
      );
      if (result.rows[0]) await this.bump(client, result.rows[0].baseId);
    });
  }

  replaceChunks(tenant: TenantContext, sourceId: string, chunks: ChunkInput[], embeddingModel: string | null) {
    return withTenant(this.pool, tenant, async (client) => {
      const source = await client.query<{ baseId: string }>(
        `SELECT base_id AS "baseId" FROM knowledge_sources WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [sourceId, tenant.organizationId],
      );
      const baseId = source.rows[0]?.baseId;
      if (!baseId) return false;

      const total = await client.query<{ count: string }>(
        "SELECT count(*) FROM knowledge_chunks WHERE base_id = $1 AND source_id <> $2",
        [baseId, sourceId],
      );
      if (Number(total.rows[0]!.count) + chunks.length > MAX_CHUNKS_PER_BASE) throw new KnowledgeLimitError("too_many_chunks");

      await client.query("DELETE FROM knowledge_chunks WHERE source_id = $1 AND organization_id = $2", [sourceId, tenant.organizationId]);

      const seal = await this.keyring.sealer(client, tenant.organizationId);
      // Insertion par lots : unnest de tableaux parallèles.
      for (let offset = 0; offset < chunks.length; offset += 500) {
        const batch = chunks.slice(offset, offset + 500);
        const ids = batch.map(() => randomUUID());
        await client.query(
          `INSERT INTO knowledge_chunks (id, organization_id, base_id, source_id, ordinal, content, embedding)
           SELECT id, $2, $3, $4, ordinal, content, embedding
           FROM unnest($1::uuid[], $5::int[], $6::text[], $7::text[]) AS t(id, ordinal, content, embedding)`,
          [
            ids,
            tenant.organizationId,
            baseId,
            sourceId,
            batch.map((_, index) => offset + index),
            batch.map((chunk, index) => seal(encodeChunk(chunk), chunkAad(tenant.organizationId, sourceId, ids[index]!, "text"))),
            batch.map((chunk, index) =>
              chunk.vector ? seal(vectorToBytes(chunk.vector), chunkAad(tenant.organizationId, sourceId, ids[index]!, "vector")) : null,
            ),
          ],
        );
      }

      await client.query(
        `UPDATE knowledge_sources SET status = 'ready', error_code = NULL, chunk_count = $3,
           embedding_model = $4, updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [sourceId, tenant.organizationId, chunks.length, embeddingModel],
      );
      await this.bump(client, baseId);
      return true;
    });
  }

  deleteSource(tenant: TenantContext, sourceId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ baseId: string }>(
        `DELETE FROM knowledge_sources WHERE id = $1 AND organization_id = $2 RETURNING base_id AS "baseId"`,
        [sourceId, tenant.organizationId],
      );
      if (!result.rows[0]) return false;
      await this.bump(client, result.rows[0].baseId);
      return true;
    });
  }

  baseRevision(tenant: TenantContext, baseId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ revision: number }>(
        "SELECT revision FROM knowledge_bases WHERE id = $1 AND organization_id = $2",
        [baseId, tenant.organizationId],
      );
      return result.rows[0]?.revision ?? null;
    });
  }

  load(tenant: TenantContext, baseId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const baseRow = await client.query<BaseRow>(`SELECT ${BASE_COLUMNS} FROM knowledge_bases WHERE id = $1 AND organization_id = $2`, [
        baseId,
        tenant.organizationId,
      ]);
      if (!baseRow.rows[0]) return null;

      const sourceRows = await client.query<{ id: string; name: string; url: string | null; model: string | null }>(
        `SELECT id, name, url, embedding_model AS model FROM knowledge_sources
         WHERE base_id = $1 AND organization_id = $2 AND status = 'ready'`,
        [baseId, tenant.organizationId],
      );
      const open = await this.keyring.opener(client, tenant.organizationId);
      const sources = new Map<string, { name: string; url: string | null }>();
      const models = new Map<string, string | null>();
      for (const row of sourceRows.rows) {
        sources.set(row.id, {
          name: (await open(row.name, sourceAad(tenant.organizationId, baseId, row.id, "name"))).toString("utf8"),
          url: row.url ? (await open(row.url, sourceAad(tenant.organizationId, baseId, row.id, "url"))).toString("utf8") : null,
        });
        models.set(row.id, row.model);
      }

      const chunkRows = await client.query<{ id: string; sourceId: string; ordinal: number; content: string; embedding: string | null }>(
        `SELECT c.id, c.source_id AS "sourceId", c.ordinal, c.content, c.embedding
         FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         WHERE c.base_id = $1 AND c.organization_id = $2 AND s.status = 'ready'`,
        [baseId, tenant.organizationId],
      );
      const chunks: IndexedChunk[] = [];
      for (const row of chunkRows.rows) {
        const chunk = decodeChunk((await open(row.content, chunkAad(tenant.organizationId, row.sourceId, row.id, "text"))).toString("utf8"));
        chunks.push({
          id: row.id,
          sourceId: row.sourceId,
          ordinal: row.ordinal,
          ...chunk,
          context: contextHeader(sources.get(row.sourceId)?.name ?? "", chunk.heading),
          vector: row.embedding
            ? bytesToVector(await open(row.embedding, chunkAad(tenant.organizationId, row.sourceId, row.id, "vector")))
            : null,
          model: models.get(row.sourceId) ?? null,
        });
      }
      return { base: toBase(baseRow.rows[0]), chunks, sources };
    });
  }

  async pending() {
    const result = await this.pool.query<{ source_id: string; organization_id: string; created_by: string }>(
      "SELECT source_id, organization_id, created_by FROM snowfall_pending_knowledge()",
    );
    return result.rows.map((row) => ({ sourceId: row.source_id, organizationId: row.organization_id, createdBy: row.created_by }));
  }
}
