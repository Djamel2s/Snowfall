import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { bytesToVector, contextHeader, vectorToBytes, type IndexedChunk } from "./search.js";

export type KnowledgeOwner = { kind: "agent"; agentId: string } | { kind: "project"; projectId: string };

/** Droit de l'utilisateur courant sur une base (calculé par la base de données). */
export type KnowledgeAccess = "owner" | "edit" | "view";

export type KnowledgeBase = {
  id: string;
  /** NULL : base reprise d'un agent ou d'un projet (l'interface la nomme d'après lui). */
  name: string | null;
  createdBy: string;
  confidential: boolean;
  revision: number;
  access: KnowledgeAccess;
};

/** Base listée dans la bibliothèque : ce qu'elle contient, où elle sert. */
export type KnowledgeBaseSummary = KnowledgeBase & {
  sourceCount: number;
  /** Partagée (au moins une autorisation). */
  shared: boolean;
  /** Agents et projets qui l'utilisent (visibles de l'utilisateur). */
  usedBy: { kind: "agent" | "project"; id: string }[];
  updatedAt: string;
};

export type KnowledgeFolder = { id: string; baseId: string; parentId: string | null; name: string; createdAt: string };

export type SourceStatus = "pending" | "processing" | "ready" | "error";

export type KnowledgeSource = {
  id: string;
  baseId: string;
  folderId: string | null;
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

export type SourcePassages = { name: string; passages: { text: string; heading: string | null; page: number | null }[] };

/** Sources par base, et passages par base (au-delà : refus d'import). */
export const MAX_SOURCES_PER_BASE = 200;
export const MAX_CHUNKS_PER_BASE = 50_000;
/** Bases par personne, dossiers par base, bases par agent ou projet. */
export const MAX_BASES_PER_USER = 50;
export const MAX_FOLDERS_PER_BASE = 200;
export const MAX_BASES_PER_OWNER = 10;

export interface KnowledgeStore {
  // ---- Bibliothèque ------------------------------------------------------------
  /** Bases de l'utilisateur et celles partagées avec lui (pas celles vues au travers d'un agent). */
  listBases(tenant: TenantContext): Promise<KnowledgeBaseSummary[]>;
  getBase(tenant: TenantContext, baseId: string): Promise<KnowledgeBase | null>;
  /** null : plafond de bases atteint. */
  createBase(tenant: TenantContext, name: string): Promise<KnowledgeBase | null>;
  renameBase(tenant: TenantContext, baseId: string, name: string): Promise<KnowledgeBase | null>;
  /** Son auteur (ou un administrateur) : la base, ses documents, dossiers et partages. */
  deleteBase(tenant: TenantContext, baseId: string): Promise<boolean>;
  setConfidential(tenant: TenantContext, baseId: string, confidential: boolean): Promise<KnowledgeBase | null>;

  // ---- Dossiers ----------------------------------------------------------------
  listFolders(tenant: TenantContext, baseId: string): Promise<KnowledgeFolder[]>;
  /** null : plafond atteint, parent d'une autre base, ou arborescence trop profonde. */
  createFolder(tenant: TenantContext, baseId: string, input: { name: string; parentId: string | null }): Promise<KnowledgeFolder | null>;
  updateFolder(tenant: TenantContext, folderId: string, input: { name?: string | undefined; parentId?: string | null | undefined }): Promise<KnowledgeFolder | null>;
  /** Supprime le dossier, ses sous-dossiers et leurs documents. */
  deleteFolder(tenant: TenantContext, folderId: string): Promise<boolean>;
  moveSource(tenant: TenantContext, sourceId: string, folderId: string | null): Promise<boolean>;

  // ---- Rattachements -----------------------------------------------------------
  /** Bases rattachées à un agent ou un projet, dans l'ordre (la première reçoit les écritures). */
  basesFor(tenant: TenantContext, owner: KnowledgeOwner): Promise<KnowledgeBase[]>;
  /** Remplace les rattachements ; false : un droit manque (la base de données refuse). */
  setBasesFor(tenant: TenantContext, owner: KnowledgeOwner, baseIds: string[]): Promise<boolean>;
  /** Compatibilité : la première base rattachée. */
  findBase(tenant: TenantContext, owner: KnowledgeOwner): Promise<KnowledgeBase | null>;
  /** Compatibilité : la première base rattachée, créée et rattachée s'il n'y en a pas. */
  ensureBase(tenant: TenantContext, owner: KnowledgeOwner): Promise<KnowledgeBase>;

  // ---- Documents ---------------------------------------------------------------
  listSources(tenant: TenantContext, baseId: string): Promise<KnowledgeSource[]>;
  addSource(
    tenant: TenantContext,
    baseId: string,
    input: { kind: "file" | "link"; name: string; url?: string; mediaType: string | null; bytes: Buffer; folderId?: string | null },
  ): Promise<KnowledgeSource>;
  getSource(tenant: TenantContext, sourceId: string): Promise<(KnowledgeSource & { base: KnowledgeBase }) | null>;
  sourceContent(tenant: TenantContext, sourceId: string): Promise<{ name: string; url: string | null; mediaType: string | null; bytes: Buffer } | null>;
  /** Texte lu d'un document, passage par passage, dans l'ordre (ouvrir une citation à sa place). */
  sourcePassages(tenant: TenantContext, sourceId: string): Promise<SourcePassages | null>;
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

/** Refus de la base de données (droit, clé étrangère, contrôle) : une réponse « non », pas une panne. */
function isRefusal(error: unknown) {
  const code = (error as { code?: string }).code;
  return code === "42501" || code === "23503" || code === "23514" || code === "23505";
}

export class KnowledgeLimitError extends Error {
  constructor(readonly code: "too_many_sources" | "too_many_chunks") {
    super(code.toUpperCase());
  }
}

// L'AAD lie chaque chiffré à son organisation, sa base et sa ligne.
export const sourceAad = (organizationId: string, baseId: string, sourceId: string, field: "name" | "url" | "content") =>
  `knowledge-${field}:${organizationId}:${baseId}:${sourceId}`;
export const chunkAad = (organizationId: string, sourceId: string, chunkId: string, field: "text" | "vector") =>
  `knowledge-chunk-${field}:${organizationId}:${sourceId}:${chunkId}`;
export const baseNameAad = (organizationId: string, baseId: string) => `knowledge-base-name:${organizationId}:${baseId}`;
export const folderNameAad = (organizationId: string, baseId: string, folderId: string) => `knowledge-folder-name:${organizationId}:${baseId}:${folderId}`;

type BaseRow = { id: string; name: string | null; createdBy: string; confidential: boolean; revision: number; access: KnowledgeAccess };
type SourceRow = {
  id: string;
  baseId: string;
  folderId: string | null;
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
type FolderRow = { id: string; baseId: string; parentId: string | null; name: string; createdAt: string };

// Droit de l'utilisateur courant, calculé par la base de données (mêmes règles que la RLS).
const ACCESS = `CASE WHEN b.created_by = nullif(current_setting('app.user_id', true), '')::uuid THEN 'owner'
  WHEN snowfall_access('knowledge_base', b.id) = 'edit' OR snowfall_is_admin() THEN 'edit' ELSE 'view' END`;
const BASE_COLUMNS = `b.id, b.name, b.created_by AS "createdBy", b.confidential, b.revision, ${ACCESS} AS access`;
const sourceColumns = (p = "") => `${p}id, ${p}base_id AS "baseId", ${p}folder_id AS "folderId", ${p}kind, ${p}status, ${p}error_code AS "errorCode",
  ${p}name, ${p}url, ${p}media_type AS "mediaType", ${p}size_bytes AS size, ${p}chunk_count AS "chunkCount",
  ${p}embedding_model AS "embeddingModel", ${p}created_at AS "createdAt", ${p}updated_at AS "updatedAt"`;
const SOURCE_COLUMNS = sourceColumns();
const FOLDER_COLUMNS = `id, base_id AS "baseId", parent_id AS "parentId", name, created_at AS "createdAt"`;

/** Nom d'une base, de 1 à 80 caractères sur une ligne. */
export function baseName(raw: string) {
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

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

  private async toBase(client: PoolClient, tenant: TenantContext, row: BaseRow): Promise<KnowledgeBase> {
    return {
      ...row,
      name: row.name ? await this.keyring.decrypt(client, tenant.organizationId, row.name, baseNameAad(tenant.organizationId, row.id)) : null,
    };
  }

  private async toFolder(client: PoolClient, tenant: TenantContext, row: FolderRow): Promise<KnowledgeFolder> {
    return { ...row, name: await this.keyring.decrypt(client, tenant.organizationId, row.name, folderNameAad(tenant.organizationId, row.baseId, row.id)) };
  }

  private async bump(client: PoolClient, baseId: string) {
    await client.query("UPDATE knowledge_bases SET revision = revision + 1, updated_at = now() WHERE id = $1", [baseId]);
  }

  private async selectBase(client: PoolClient, tenant: TenantContext, baseId: string) {
    const row = (await client.query<BaseRow>(`SELECT ${BASE_COLUMNS} FROM knowledge_bases b WHERE b.id = $1 AND b.organization_id = $2`, [baseId, tenant.organizationId])).rows[0];
    return row ? this.toBase(client, tenant, row) : null;
  }

  // ---- Bibliothèque --------------------------------------------------------------

  listBases(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<BaseRow & { sourceCount: string; shared: boolean; updatedAt: string; agents: string[] | null; projects: string[] | null }>(
        `SELECT ${BASE_COLUMNS}, b.updated_at AS "updatedAt",
           (SELECT count(*) FROM knowledge_sources s WHERE s.base_id = b.id) AS "sourceCount",
           EXISTS (SELECT 1 FROM resource_grants g WHERE g.organization_id = b.organization_id AND g.resource_type = 'knowledge_base' AND g.resource_id = b.id) AS shared,
           (SELECT array_agg(l.agent_id ORDER BY l.agent_id) FROM agent_knowledge_bases l JOIN agents a ON a.id = l.agent_id WHERE l.base_id = b.id) AS agents,
           (SELECT array_agg(l.project_id ORDER BY l.project_id) FROM project_knowledge_bases l WHERE l.base_id = b.id) AS projects
         FROM knowledge_bases b
         WHERE b.organization_id = $1
           AND (b.created_by = $2 OR snowfall_access('knowledge_base', b.id) IS NOT NULL
             -- Base reprise d'un projet : à son auteur, déjà couvert ; d'un agent qu'il a créé : idem.
             OR EXISTS (SELECT 1 FROM project_knowledge_bases l WHERE l.base_id = b.id AND l.user_id = $2))
         ORDER BY b.updated_at DESC`,
        [tenant.organizationId, tenant.userId],
      );
      const bases: KnowledgeBaseSummary[] = [];
      for (const row of rows.rows) {
        const { sourceCount, shared, updatedAt, agents, projects, ...base } = row;
        bases.push({
          ...(await this.toBase(client, tenant, base)),
          sourceCount: Number(sourceCount),
          shared,
          updatedAt,
          usedBy: [...(agents ?? []).map((id) => ({ kind: "agent" as const, id })), ...(projects ?? []).map((id) => ({ kind: "project" as const, id }))],
        });
      }
      return bases;
    });
  }

  getBase(tenant: TenantContext, baseId: string) {
    return withTenant(this.pool, tenant, (client) => this.selectBase(client, tenant, baseId));
  }

  createBase(tenant: TenantContext, name: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const count = await client.query<{ count: string }>("SELECT count(*) FROM knowledge_bases WHERE organization_id = $1 AND created_by = $2", [tenant.organizationId, tenant.userId]);
      if (Number(count.rows[0]!.count) >= MAX_BASES_PER_USER) return null;
      const id = randomUUID();
      await client.query(`INSERT INTO knowledge_bases (id, organization_id, created_by, name) VALUES ($1, $2, $3, $4)`, [
        id,
        tenant.organizationId,
        tenant.userId,
        await this.keyring.encrypt(client, tenant.organizationId, name, baseNameAad(tenant.organizationId, id)),
      ]);
      return this.selectBase(client, tenant, id);
    });
  }

  renameBase(tenant: TenantContext, baseId: string, name: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(`UPDATE knowledge_bases SET name = $3, updated_at = now() WHERE id = $1 AND organization_id = $2`, [
        baseId,
        tenant.organizationId,
        await this.keyring.encrypt(client, tenant.organizationId, name, baseNameAad(tenant.organizationId, baseId)),
      ]);
      return result.rowCount ? this.selectBase(client, tenant, baseId) : null;
    });
  }

  deleteBase(tenant: TenantContext, baseId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // Partages d'abord (pas de clé étrangère sur resource_grants), tant que l'auteur est reconnu.
      await client.query("DELETE FROM resource_grants WHERE organization_id = $1 AND resource_type = 'knowledge_base' AND resource_id = $2", [tenant.organizationId, baseId]);
      const result = await client.query("DELETE FROM knowledge_bases WHERE id = $1 AND organization_id = $2", [baseId, tenant.organizationId]);
      return Boolean(result.rowCount);
    });
  }

  setConfidential(tenant: TenantContext, baseId: string, confidential: boolean) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        `UPDATE knowledge_bases SET confidential = $3, revision = revision + 1, updated_at = now() WHERE id = $1 AND organization_id = $2`,
        [baseId, tenant.organizationId, confidential],
      );
      return result.rowCount ? this.selectBase(client, tenant, baseId) : null;
    });
  }

  // ---- Dossiers --------------------------------------------------------------------

  listFolders(tenant: TenantContext, baseId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<FolderRow>(`SELECT ${FOLDER_COLUMNS} FROM knowledge_folders WHERE base_id = $1 AND organization_id = $2 ORDER BY created_at`, [baseId, tenant.organizationId]);
      const folders: KnowledgeFolder[] = [];
      for (const row of rows.rows) folders.push(await this.toFolder(client, tenant, row));
      return folders;
    });
  }

  createFolder(tenant: TenantContext, baseId: string, input: { name: string; parentId: string | null }) {
    return withTenant(this.pool, tenant, async (client) => {
      const count = await client.query<{ count: string }>("SELECT count(*) FROM knowledge_folders WHERE base_id = $1 AND organization_id = $2", [baseId, tenant.organizationId]);
      if (Number(count.rows[0]!.count) >= MAX_FOLDERS_PER_BASE) return null;
      const id = randomUUID();
      try {
        const row = (
          await client.query<FolderRow>(
            `INSERT INTO knowledge_folders (id, organization_id, base_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${FOLDER_COLUMNS}`,
            [id, tenant.organizationId, baseId, input.parentId, await this.keyring.encrypt(client, tenant.organizationId, input.name, folderNameAad(tenant.organizationId, baseId, id)), tenant.userId],
          )
        ).rows[0]!;
        await this.bump(client, baseId);
        return this.toFolder(client, tenant, row);
      } catch (error) {
        // Parent d'une autre base (clé composée), trop profond (trigger), ou base non modifiable (RLS).
        if (isRefusal(error)) return null;
        throw error;
      }
    });
  }

  updateFolder(tenant: TenantContext, folderId: string, input: { name?: string | undefined; parentId?: string | null | undefined }) {
    return withTenant(this.pool, tenant, async (client) => {
      const current = (await client.query<FolderRow>(`SELECT ${FOLDER_COLUMNS} FROM knowledge_folders WHERE id = $1 AND organization_id = $2`, [folderId, tenant.organizationId])).rows[0];
      if (!current) return null;
      try {
        await client.query("SAVEPOINT folder_update");
        const name = input.name !== undefined ? await this.keyring.encrypt(client, tenant.organizationId, input.name, folderNameAad(tenant.organizationId, current.baseId, folderId)) : current.name;
        const parentId = input.parentId !== undefined ? input.parentId : current.parentId;
        const row = (
          await client.query<FolderRow>(`UPDATE knowledge_folders SET name = $3, parent_id = $4, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING ${FOLDER_COLUMNS}`, [
            folderId,
            tenant.organizationId,
            name,
            parentId,
          ])
        ).rows[0];
        if (!row) return null;
        await this.bump(client, current.baseId);
        return this.toFolder(client, tenant, row);
      } catch (error) {
        // Boucle (dans un de ses descendants), trop profond, autre base : refusé par la base de données.
        if (isRefusal(error)) {
          await client.query("ROLLBACK TO SAVEPOINT folder_update");
          return null;
        }
        throw error;
      }
    });
  }

  deleteFolder(tenant: TenantContext, folderId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ baseId: string }>(`DELETE FROM knowledge_folders WHERE id = $1 AND organization_id = $2 RETURNING base_id AS "baseId"`, [folderId, tenant.organizationId]);
      if (!result.rows[0]) return false;
      await this.bump(client, result.rows[0].baseId);
      return true;
    });
  }

  moveSource(tenant: TenantContext, sourceId: string, folderId: string | null) {
    return withTenant(this.pool, tenant, async (client) => {
      try {
        await client.query("SAVEPOINT source_move");
        // Le dossier doit être de la même base : garanti par la clé composée (folder_id, base_id).
        const result = await client.query(`UPDATE knowledge_sources SET folder_id = $3, updated_at = now() WHERE id = $1 AND organization_id = $2`, [sourceId, tenant.organizationId, folderId]);
        return Boolean(result.rowCount);
      } catch (error) {
        if (isRefusal(error)) {
          await client.query("ROLLBACK TO SAVEPOINT source_move");
          return false;
        }
        throw error;
      }
    });
  }

  // ---- Rattachements ---------------------------------------------------------------

  private async linkedBases(client: PoolClient, tenant: TenantContext, owner: KnowledgeOwner) {
    const rows = await client.query<BaseRow>(
      owner.kind === "agent"
        ? `SELECT ${BASE_COLUMNS} FROM agent_knowledge_bases l JOIN knowledge_bases b ON b.id = l.base_id AND b.organization_id = l.organization_id
           WHERE l.agent_id = $1 AND l.organization_id = $2 ORDER BY l.position, l.created_at`
        : `SELECT ${BASE_COLUMNS} FROM project_knowledge_bases l JOIN knowledge_bases b ON b.id = l.base_id AND b.organization_id = l.organization_id
           WHERE l.project_id = $1 AND l.organization_id = $2 AND l.user_id = $3 ORDER BY l.position, l.created_at`,
      owner.kind === "agent" ? [owner.agentId, tenant.organizationId] : [owner.projectId, tenant.organizationId, tenant.userId],
    );
    const bases: KnowledgeBase[] = [];
    for (const row of rows.rows) bases.push(await this.toBase(client, tenant, row));
    return bases;
  }

  basesFor(tenant: TenantContext, owner: KnowledgeOwner) {
    return withTenant(this.pool, tenant, (client) => this.linkedBases(client, tenant, owner));
  }

  private async link(client: PoolClient, tenant: TenantContext, owner: KnowledgeOwner, baseId: string, position: number) {
    if (owner.kind === "agent") {
      await client.query(`INSERT INTO agent_knowledge_bases (agent_id, organization_id, base_id, position, created_by) VALUES ($1, $2, $3, $4, $5)`, [
        owner.agentId,
        tenant.organizationId,
        baseId,
        position,
        tenant.userId,
      ]);
    } else {
      await client.query(`INSERT INTO project_knowledge_bases (project_id, organization_id, user_id, base_id, position) VALUES ($1, $2, $3, $4, $5)`, [
        owner.projectId,
        tenant.organizationId,
        tenant.userId,
        baseId,
        position,
      ]);
    }
  }

  setBasesFor(tenant: TenantContext, owner: KnowledgeOwner, baseIds: string[]) {
    return withTenant(this.pool, tenant, async (client) => {
      const wanted = [...new Set(baseIds)].slice(0, MAX_BASES_PER_OWNER);
      try {
        await client.query("SAVEPOINT links");
        if (owner.kind === "agent") {
          // Déjà rattachées : gardées telles quelles (un éditeur de l'agent peut réordonner
          // ou retirer une base qu'il ne pourrait pas rattacher lui-même).
          await client.query("DELETE FROM agent_knowledge_bases WHERE agent_id = $1 AND organization_id = $2 AND NOT (base_id = ANY($3::uuid[]))", [owner.agentId, tenant.organizationId, wanted]);
          const kept = new Set((await client.query<{ baseId: string }>(`SELECT base_id AS "baseId" FROM agent_knowledge_bases WHERE agent_id = $1 AND organization_id = $2`, [owner.agentId, tenant.organizationId])).rows.map((row) => row.baseId));
          for (const [position, baseId] of wanted.entries()) {
            if (kept.has(baseId)) await client.query("UPDATE agent_knowledge_bases SET position = $4 WHERE agent_id = $1 AND organization_id = $2 AND base_id = $3", [owner.agentId, tenant.organizationId, baseId, position]);
            else await this.link(client, tenant, owner, baseId, position);
          }
        } else {
          await client.query("DELETE FROM project_knowledge_bases WHERE project_id = $1 AND organization_id = $2 AND user_id = $3", [owner.projectId, tenant.organizationId, tenant.userId]);
          for (const [position, baseId] of wanted.entries()) await this.link(client, tenant, owner, baseId, position);
        }
        return true;
      } catch (error) {
        if (isRefusal(error)) {
          await client.query("ROLLBACK TO SAVEPOINT links");
          return false;
        }
        throw error;
      }
    });
  }

  findBase(tenant: TenantContext, owner: KnowledgeOwner) {
    return withTenant(this.pool, tenant, async (client) => (await this.linkedBases(client, tenant, owner))[0] ?? null);
  }

  ensureBase(tenant: TenantContext, owner: KnowledgeOwner) {
    return withTenant(this.pool, tenant, async (client) => {
      const existing = (await this.linkedBases(client, tenant, owner))[0];
      if (existing) return existing;
      // L'agent ou le projet doit exister (et être visible) : contrôlé ici, puis
      // garanti par les clés étrangères composites et la RLS des rattachements.
      const parent =
        owner.kind === "agent"
          ? await client.query("SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2", [owner.agentId, tenant.organizationId])
          : await client.query("SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2 AND user_id = $3", [owner.projectId, tenant.organizationId, tenant.userId]);
      if (!parent.rowCount) throw new Error(owner.kind === "agent" ? "AGENT_NOT_FOUND" : "PROJECT_NOT_FOUND");
      const id = randomUUID();
      await client.query(`INSERT INTO knowledge_bases (id, organization_id, created_by) VALUES ($1, $2, $3)`, [id, tenant.organizationId, tenant.userId]);
      await this.link(client, tenant, owner, id, 0);
      const created = await this.selectBase(client, tenant, id);
      if (!created) throw new Error("KNOWLEDGE_BASE_UNAVAILABLE");
      return created;
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
    input: { kind: "file" | "link"; name: string; url?: string; mediaType: string | null; bytes: Buffer; folderId?: string | null },
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
           (id, organization_id, base_id, created_by, kind, media_type, size_bytes, name, url, content, folder_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          input.folderId ?? null,
        ],
      );
      await this.bump(client, baseId);
      return { ...result.rows[0]!, name: input.name, url: input.url ?? null };
    });
  }

  getSource(tenant: TenantContext, sourceId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM knowledge_sources WHERE id = $1 AND organization_id = $2`, [sourceId, tenant.organizationId]);
      const row = result.rows[0];
      if (!row) return null;
      const base = await this.selectBase(client, tenant, row.baseId);
      if (!base) return null;
      return { ...(await this.decryptSource(client, tenant, row)), base };
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

  sourcePassages(tenant: TenantContext, sourceId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const source = (
        await client.query<{ baseId: string; name: string }>(
          `SELECT base_id AS "baseId", name FROM knowledge_sources WHERE id = $1 AND organization_id = $2 AND status = 'ready'`,
          [sourceId, tenant.organizationId],
        )
      ).rows[0];
      if (!source) return null;
      const open = await this.keyring.opener(client, tenant.organizationId);
      const rows = await client.query<{ id: string; content: string }>(
        `SELECT id, content FROM knowledge_chunks WHERE source_id = $1 AND organization_id = $2 ORDER BY ordinal`,
        [sourceId, tenant.organizationId],
      );
      const passages = [];
      for (const row of rows.rows) passages.push(decodeChunk((await open(row.content, chunkAad(tenant.organizationId, sourceId, row.id, "text"))).toString("utf8")));
      return { name: (await open(source.name, sourceAad(tenant.organizationId, source.baseId, sourceId, "name"))).toString("utf8"), passages };
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
      const base = await this.selectBase(client, tenant, baseId);
      if (!base) return null;

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
      return { base, chunks, sources };
    });
  }

  async pending() {
    const result = await this.pool.query<{ source_id: string; organization_id: string; created_by: string }>(
      "SELECT source_id, organization_id, created_by FROM snowfall_pending_knowledge()",
    );
    return result.rows.map((row) => ({ sourceId: row.source_id, organizationId: row.organization_id, createdBy: row.created_by }));
  }
}
