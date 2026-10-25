import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Compétences (skills) : un savoir-faire que l'agent charge à la demande. Le
// modèle ne voit d'abord que le nom et la description ; il appelle use_skill
// pour les instructions complètes, puis read_skill_file pour une référence.
// Chargement possible seulement pour une compétence confiée à l'agent.

/** hasOriginal : modèle binaire gardé pour les scripts (Word, PDF, Excel, image). */
export type SkillFileMeta = { id: string; name: string; mediaType: string; size: number; createdAt: string; hasOriginal: boolean };
export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  confidential: boolean;
  version: number;
  mine: boolean;
  /** L'auteur, ou un éditeur autorisé. */
  canEdit: boolean;
  /** Partagée avec quelqu'un (vu par son auteur). */
  shared: boolean;
  files: SkillFileMeta[];
  updatedAt: string;
};
export type SkillInput = { name: string; description: string; instructions: string; confidential: boolean };
export type SkillVersion = { version: number; editedBy: string; createdAt: string };
export type SkillCatalogEntry = { id: string; name: string; description: string; confidential: boolean };
/** hasOriginal : un modèle binaire est gardé (copié à côté des scripts, jamais lu par le modèle). */
export type LoadedSkill = { id: string; name: string; instructions: string; files: { id: string; name: string; mediaType: string; hasOriginal: boolean }[] };
export type SkillFileInput = { name: string; mediaType: string; size: number; text: string; original?: Buffer | undefined };

export const MAX_SKILL_FILES = 10;
export const MAX_AGENT_SKILLS = 10;

export class SkillRuleError extends Error {
  constructor(readonly code: "TOO_MANY_FILES" | "FORBIDDEN") {
    super(code);
  }
}

export interface SkillStore {
  /** Bibliothèque : les miennes et celles qu'on me partage. */
  list(tenant: TenantContext): Promise<Skill[]>;
  get(tenant: TenantContext, id: string): Promise<Skill | null>;
  create(tenant: TenantContext, input: SkillInput): Promise<Skill>;
  /** Auteur ou éditeur ; une nouvelle version si la description ou les instructions changent. */
  update(tenant: TenantContext, id: string, input: SkillInput): Promise<Skill | null>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
  versions(tenant: TenantContext, id: string): Promise<SkillVersion[]>;
  addFile(tenant: TenantContext, skillId: string, file: SkillFileInput): Promise<SkillFileMeta | null>;
  removeFile(tenant: TenantContext, skillId: string, fileId: string): Promise<boolean>;
  /** Compétences confiées à un agent (nom et description seulement). */
  forAgent(tenant: TenantContext, agentId: string): Promise<SkillCatalogEntry[]>;
  load(tenant: TenantContext, agentId: string, skillId: string): Promise<LoadedSkill | null>;
  readFile(tenant: TenantContext, agentId: string, skillId: string, fileId: string): Promise<{ name: string; text: string } | null>;
  /** Octets d'origine d'un modèle binaire (bac à sable seulement). */
  readOriginal(tenant: TenantContext, agentId: string, skillId: string, fileId: string): Promise<Buffer | null>;
}

export const skillAad = (organizationId: string, id: string, field: "name" | "description" | "instructions") => `skill-${field}:${organizationId}:${id}`;
export const skillFileAad = (organizationId: string, id: string, field: "name" | "content" | "original") => `skill-file-${field}:${organizationId}:${id}`;
export const skillVersionAad = (organizationId: string, id: string, field: "description" | "instructions") => `skill-version-${field}:${organizationId}:${id}`;

type Row = {
  id: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  confidential: boolean;
  version: number;
  access: "view" | "edit" | null;
  shared: boolean;
  updatedAt: string;
};
const COLUMNS = `id, user_id AS "userId", name, description, instructions, confidential, version, updated_at AS "updatedAt",
  snowfall_access('skill', id) AS access,
  EXISTS (SELECT 1 FROM resource_grants g WHERE g.organization_id = skills.organization_id AND g.resource_type = 'skill' AND g.resource_id = skills.id) AS shared`;
/** Bibliothèque : exclut les compétences vues seulement à travers un agent. */
const MINE_OR_SHARED = `(user_id = $2 OR snowfall_access('skill', id) IS NOT NULL)`;
/** Compétence confiée à cet agent (la RLS vérifie qu'on voit l'agent). */
const ATTACHED = `EXISTS (SELECT 1 FROM agent_skills x JOIN agents a ON a.id = x.agent_id WHERE x.skill_id = skills.id AND x.agent_id = $2)`;

export class PostgresSkillStore implements SkillStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private decrypt(client: PoolClient, tenant: TenantContext, value: string, aad: string) {
    return this.keyring.decrypt(client, tenant.organizationId, value, aad);
  }

  private async files(client: PoolClient, tenant: TenantContext, skillId: string) {
    const rows = await client.query<{ id: string; name: string; mediaType: string; size: number; createdAt: string; hasOriginal: boolean }>(
      `SELECT id, name, media_type AS "mediaType", size_bytes AS size, created_at AS "createdAt", original IS NOT NULL AS "hasOriginal"
       FROM skill_files WHERE organization_id = $1 AND skill_id = $2 ORDER BY created_at, id`,
      [tenant.organizationId, skillId],
    );
    const files: SkillFileMeta[] = [];
    for (const row of rows.rows) {
      files.push({ ...row, name: await this.decrypt(client, tenant, row.name, skillFileAad(tenant.organizationId, row.id, "name")), createdAt: new Date(row.createdAt).toISOString() });
    }
    return files;
  }

  private async view(client: PoolClient, tenant: TenantContext, row: Row): Promise<Skill> {
    const mine = row.userId === tenant.userId;
    const org = tenant.organizationId;
    return {
      id: row.id,
      name: await this.decrypt(client, tenant, row.name, skillAad(org, row.id, "name")),
      description: await this.decrypt(client, tenant, row.description, skillAad(org, row.id, "description")),
      instructions: await this.decrypt(client, tenant, row.instructions, skillAad(org, row.id, "instructions")),
      confidential: row.confidential,
      version: row.version,
      mine,
      canEdit: mine || row.access === "edit",
      shared: mine && row.shared,
      files: await this.files(client, tenant, row.id),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private async seal(client: PoolClient, tenant: TenantContext, id: string, input: SkillInput) {
    const org = tenant.organizationId;
    return Promise.all([
      this.keyring.encrypt(client, org, input.name, skillAad(org, id, "name")),
      this.keyring.encrypt(client, org, input.description, skillAad(org, id, "description")),
      this.keyring.encrypt(client, org, input.instructions, skillAad(org, id, "instructions")),
    ]);
  }

  private async addVersion(client: PoolClient, tenant: TenantContext, skillId: string, ownerId: string, version: number, input: SkillInput) {
    const id = randomUUID();
    const org = tenant.organizationId;
    await client.query(
      `INSERT INTO skill_versions (id, skill_id, organization_id, user_id, edited_by, version, description, instructions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        skillId,
        org,
        ownerId,
        tenant.userId,
        version,
        await this.keyring.encrypt(client, org, input.description, skillVersionAad(org, id, "description")),
        await this.keyring.encrypt(client, org, input.instructions, skillVersionAad(org, id, "instructions")),
      ],
    );
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<Row>(`SELECT ${COLUMNS} FROM skills WHERE organization_id = $1 AND ${MINE_OR_SHARED} ORDER BY updated_at DESC LIMIT 200`, [tenant.organizationId, tenant.userId]);
      const items: Skill[] = [];
      for (const row of rows.rows) items.push(await this.view(client, tenant, row));
      return items;
    });
  }

  get(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<Row>(`SELECT ${COLUMNS} FROM skills WHERE organization_id = $1 AND ${MINE_OR_SHARED} AND id = $3`, [tenant.organizationId, tenant.userId, id])).rows[0];
      return row ? this.view(client, tenant, row) : null;
    });
  }

  create(tenant: TenantContext, input: SkillInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const [name, description, instructions] = await this.seal(client, tenant, id, input);
      const row = (
        await client.query<Row>(
          `INSERT INTO skills (id, organization_id, user_id, name, description, instructions, confidential)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, name, description, instructions, input.confidential],
        )
      ).rows[0]!;
      await this.addVersion(client, tenant, id, tenant.userId, 1, input);
      return this.view(client, tenant, row);
    });
  }

  update(tenant: TenantContext, id: string, input: SkillInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const current = (await client.query<Row>(`SELECT ${COLUMNS} FROM skills WHERE organization_id = $1 AND ${MINE_OR_SHARED} AND id = $3 FOR UPDATE`, [tenant.organizationId, tenant.userId, id])).rows[0];
      if (!current) return null;
      if (current.userId !== tenant.userId && current.access !== "edit") return null;
      const before = await this.view(client, tenant, current);
      const changed = before.description !== input.description || before.instructions !== input.instructions;
      const version = changed ? current.version + 1 : current.version;
      const [name, description, instructions] = await this.seal(client, tenant, id, input);
      // Rendre une compétence non confidentielle : réservé à son auteur.
      const confidential = current.userId === tenant.userId ? input.confidential : current.confidential || input.confidential;
      const row = (
        await client.query<Row>(
          `UPDATE skills SET name = $3, description = $4, instructions = $5, confidential = $6, version = $7, updated_at = now()
           WHERE organization_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
          [tenant.organizationId, id, name, description, instructions, confidential, version],
        )
      ).rows[0];
      if (!row) return null;
      if (changed) await this.addVersion(client, tenant, id, current.userId, version, input);
      return this.view(client, tenant, row);
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const owned = await client.query("SELECT 1 FROM skills WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      if (!owned.rowCount) return false;
      // Ses autorisations partent avec elle (fichiers, versions, liens : clés étrangères).
      await client.query("DELETE FROM resource_grants WHERE organization_id = $1 AND resource_type = 'skill' AND resource_id = $2", [tenant.organizationId, id]);
      const result = await client.query("DELETE FROM skills WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  versions(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<SkillVersion>(
        `SELECT v.version, v.edited_by AS "editedBy", v.created_at AS "createdAt" FROM skill_versions v
         JOIN skills s ON s.id = v.skill_id
         WHERE v.organization_id = $1 AND v.skill_id = $2 AND (s.user_id = $3 OR snowfall_access('skill', s.id) IS NOT NULL)
         ORDER BY v.version DESC LIMIT 50`,
        [tenant.organizationId, id, tenant.userId],
      );
      return rows.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
    });
  }

  addFile(tenant: TenantContext, skillId: string, file: SkillFileInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const skill = (
        await client.query<{ userId: string; access: string | null }>(
          `SELECT user_id AS "userId", snowfall_access('skill', id) AS access FROM skills WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [skillId, tenant.organizationId],
        )
      ).rows[0];
      if (!skill || (skill.userId !== tenant.userId && skill.access !== "edit")) return null;
      const count = await client.query<{ count: string }>("SELECT count(*) FROM skill_files WHERE skill_id = $1 AND organization_id = $2", [skillId, tenant.organizationId]);
      if (Number(count.rows[0]!.count) >= MAX_SKILL_FILES) throw new SkillRuleError("TOO_MANY_FILES");
      const id = randomUUID();
      const org = tenant.organizationId;
      const row = (
        await client.query<{ createdAt: string }>(
          `INSERT INTO skill_files (id, skill_id, organization_id, user_id, name, content, original, media_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING created_at AS "createdAt"`,
          [
            id,
            skillId,
            org,
            skill.userId,
            await this.keyring.encrypt(client, org, file.name, skillFileAad(org, id, "name")),
            await this.keyring.encrypt(client, org, file.text, skillFileAad(org, id, "content")),
            file.original ? await this.keyring.encryptBytes(client, org, file.original, skillFileAad(org, id, "original")) : null,
            file.mediaType,
            file.size,
          ],
        )
      ).rows[0]!;
      await client.query("UPDATE skills SET updated_at = now() WHERE id = $1 AND organization_id = $2", [skillId, org]);
      return { id, name: file.name, mediaType: file.mediaType, size: file.size, createdAt: new Date(row.createdAt).toISOString(), hasOriginal: Boolean(file.original) };
    });
  }

  removeFile(tenant: TenantContext, skillId: string, fileId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // La RLS ne laisse supprimer que l'auteur ou un éditeur de la compétence.
      const result = await client.query("DELETE FROM skill_files WHERE id = $1 AND skill_id = $2 AND organization_id = $3", [fileId, skillId, tenant.organizationId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  forAgent(tenant: TenantContext, agentId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<{ id: string; name: string; description: string; confidential: boolean }>(
        `SELECT id, name, description, confidential FROM skills WHERE organization_id = $1 AND ${ATTACHED} ORDER BY created_at, id`,
        [tenant.organizationId, agentId],
      );
      const items: SkillCatalogEntry[] = [];
      for (const row of rows.rows) {
        items.push({
          id: row.id,
          name: await this.decrypt(client, tenant, row.name, skillAad(tenant.organizationId, row.id, "name")),
          description: await this.decrypt(client, tenant, row.description, skillAad(tenant.organizationId, row.id, "description")),
          confidential: row.confidential,
        });
      }
      return items;
    });
  }

  load(tenant: TenantContext, agentId: string, skillId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ id: string; name: string; instructions: string }>(
          `SELECT id, name, instructions FROM skills WHERE organization_id = $1 AND ${ATTACHED} AND id = $3`,
          [tenant.organizationId, agentId, skillId],
        )
      ).rows[0];
      if (!row) return null;
      const files = await this.files(client, tenant, row.id);
      return {
        id: row.id,
        name: await this.decrypt(client, tenant, row.name, skillAad(tenant.organizationId, row.id, "name")),
        instructions: await this.decrypt(client, tenant, row.instructions, skillAad(tenant.organizationId, row.id, "instructions")),
        files: files.map((file) => ({ id: file.id, name: file.name, mediaType: file.mediaType, hasOriginal: file.hasOriginal })),
      };
    });
  }

  readFile(tenant: TenantContext, agentId: string, skillId: string, fileId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ id: string; name: string; content: string }>(
          `SELECT f.id, f.name, f.content FROM skill_files f JOIN skills ON skills.id = f.skill_id
           WHERE f.organization_id = $1 AND ${ATTACHED} AND f.skill_id = $3 AND f.id = $4`,
          [tenant.organizationId, agentId, skillId, fileId],
        )
      ).rows[0];
      if (!row) return null;
      return {
        name: await this.decrypt(client, tenant, row.name, skillFileAad(tenant.organizationId, row.id, "name")),
        text: await this.decrypt(client, tenant, row.content, skillFileAad(tenant.organizationId, row.id, "content")),
      };
    });
  }

  readOriginal(tenant: TenantContext, agentId: string, skillId: string, fileId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ id: string; original: string | null }>(
          `SELECT f.id, f.original FROM skill_files f JOIN skills ON skills.id = f.skill_id
           WHERE f.organization_id = $1 AND ${ATTACHED} AND f.skill_id = $3 AND f.id = $4`,
          [tenant.organizationId, agentId, skillId, fileId],
        )
      ).rows[0];
      if (!row?.original) return null;
      return this.keyring.decryptBytes(client, tenant.organizationId, row.original, skillFileAad(tenant.organizationId, row.id, "original"));
    });
  }
}

type MemorySkill = Omit<Skill, "mine" | "canEdit" | "shared"> & { tenant: TenantContext; fileTexts: Map<string, string>; originals: Map<string, Buffer>; history: SkillVersion[] };

/**
 * En mémoire : développement sans base, tests. `access` dit le droit accordé
 * (magasin de partage) ; `attachedTo` dit quelles compétences un agent utilise.
 */
export class MemorySkillStore implements SkillStore {
  private readonly items = new Map<string, MemorySkill>();

  constructor(
    private readonly access: (tenant: TenantContext, id: string) => "view" | "edit" | null = () => null,
    private readonly attachedTo: (tenant: TenantContext, agentId: string) => Promise<string[]> = async () => [],
  ) {}

  private visible(tenant: TenantContext, item: MemorySkill) {
    return item.tenant.organizationId === tenant.organizationId && (item.tenant.userId === tenant.userId || this.access(tenant, item.id) !== null);
  }

  private view(item: MemorySkill, tenant: TenantContext): Skill {
    const { tenant: owner, fileTexts: _texts, history: _history, ...rest } = item;
    const mine = owner.userId === tenant.userId;
    return structuredClone({ ...rest, mine, canEdit: mine || this.access(tenant, item.id) === "edit", shared: false });
  }

  async list(tenant: TenantContext) {
    return [...this.items.values()].filter((item) => this.visible(tenant, item)).map((item) => this.view(item, tenant));
  }

  async get(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    return item && this.visible(tenant, item) ? this.view(item, tenant) : null;
  }

  async create(tenant: TenantContext, input: SkillInput) {
    const item: MemorySkill = { id: randomUUID(), ...input, version: 1, files: [], updatedAt: new Date().toISOString(), tenant, fileTexts: new Map(), originals: new Map(), history: [] };
    item.history.push({ version: 1, editedBy: tenant.userId, createdAt: item.updatedAt });
    this.items.set(item.id, item);
    return this.view(item, tenant);
  }

  async update(tenant: TenantContext, id: string, input: SkillInput) {
    const item = this.items.get(id);
    if (!item || !this.visible(tenant, item)) return null;
    const mine = item.tenant.userId === tenant.userId;
    if (!mine && this.access(tenant, id) !== "edit") return null;
    const changed = item.description !== input.description || item.instructions !== input.instructions;
    Object.assign(item, { ...input, confidential: mine ? input.confidential : item.confidential || input.confidential, updatedAt: new Date().toISOString() });
    if (changed) {
      item.version += 1;
      item.history.push({ version: item.version, editedBy: tenant.userId, createdAt: item.updatedAt });
    }
    return this.view(item, tenant);
  }

  async delete(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    if (!item || item.tenant.userId !== tenant.userId || item.tenant.organizationId !== tenant.organizationId) return false;
    return this.items.delete(id);
  }

  async versions(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    return item && this.visible(tenant, item) ? [...item.history].reverse() : [];
  }

  async addFile(tenant: TenantContext, skillId: string, file: SkillFileInput) {
    const item = this.items.get(skillId);
    if (!item || !this.visible(tenant, item) || (item.tenant.userId !== tenant.userId && this.access(tenant, skillId) !== "edit")) return null;
    if (item.files.length >= MAX_SKILL_FILES) throw new SkillRuleError("TOO_MANY_FILES");
    const meta = { id: randomUUID(), name: file.name, mediaType: file.mediaType, size: file.size, createdAt: new Date().toISOString(), hasOriginal: Boolean(file.original) };
    item.files.push(meta);
    item.fileTexts.set(meta.id, file.text);
    if (file.original) item.originals.set(meta.id, Buffer.from(file.original));
    return meta;
  }

  async removeFile(tenant: TenantContext, skillId: string, fileId: string) {
    const item = this.items.get(skillId);
    if (!item || !this.visible(tenant, item) || (item.tenant.userId !== tenant.userId && this.access(tenant, skillId) !== "edit")) return false;
    const before = item.files.length;
    item.files = item.files.filter((file) => file.id !== fileId);
    item.fileTexts.delete(fileId);
    item.originals.delete(fileId);
    return item.files.length < before;
  }

  private async attached(tenant: TenantContext, agentId: string, skillId?: string) {
    const ids = await this.attachedTo(tenant, agentId);
    return [...this.items.values()].filter((item) => item.tenant.organizationId === tenant.organizationId && ids.includes(item.id) && (!skillId || item.id === skillId));
  }

  async forAgent(tenant: TenantContext, agentId: string) {
    return (await this.attached(tenant, agentId)).map(({ id, name, description, confidential }) => ({ id, name, description, confidential }));
  }

  async load(tenant: TenantContext, agentId: string, skillId: string) {
    const item = (await this.attached(tenant, agentId, skillId))[0];
    return item ? { id: item.id, name: item.name, instructions: item.instructions, files: item.files.map(({ id, name, mediaType }) => ({ id, name, mediaType, hasOriginal: item.originals.has(id) })) } : null;
  }

  async readFile(tenant: TenantContext, agentId: string, skillId: string, fileId: string) {
    const item = (await this.attached(tenant, agentId, skillId))[0];
    const file = item?.files.find((entry) => entry.id === fileId);
    return item && file ? { name: file.name, text: item.fileTexts.get(fileId) ?? "" } : null;
  }

  async readOriginal(tenant: TenantContext, agentId: string, skillId: string, fileId: string) {
    const item = (await this.attached(tenant, agentId, skillId))[0];
    return item?.originals.get(fileId) ?? null;
  }
}
