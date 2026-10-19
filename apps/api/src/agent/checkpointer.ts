import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, type Checkpoint, type CheckpointMetadata, type CheckpointTuple } from "@langchain/langgraph";
import type { Pool, PoolClient } from "pg";

// Types et constantes du contrat de @langchain/langgraph-checkpoint, non
// réexportés par @langchain/langgraph (copie de base.js, version 1.1).
type CheckpointListOptions = NonNullable<Parameters<BaseCheckpointSaver["list"]>[1]>;
type PendingWrite = Parameters<BaseCheckpointSaver["putWrites"]>[1][number];
type CheckpointPendingWrite = NonNullable<CheckpointTuple["pendingWrites"]>[number];
const WRITES_IDX_MAP: Record<string, number> = { __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 };
const getCheckpointId = (config: RunnableConfig): string =>
  (config.configurable?.checkpoint_id as string | undefined) || (config.configurable?.thread_ts as string | undefined) || "";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CheckpointRow = { checkpoint_id: string; parent_id: string | null; checkpoint: string; metadata: string };
type WriteRow = { task_id: string; idx: number; channel: string; value: string };

/**
 * Points de reprise LangGraph dans PostgreSQL, chiffrés avec la clé de
 * l'organisation (AES-256-GCM, AAD liée au run et au point de reprise).
 *
 * Une instance par run : le tenant est fixé à la construction et chaque accès
 * passe par la RLS de son propriétaire. thread_id = identifiant du run, ou
 * « run~clé » pour le sous-fil d'un sous-agent (équipes d'agents) : effacer le
 * run efface tous ses sous-fils. Pas de sous-graphes : l'espace de noms est vide.
 */
/** AAD d'un point de reprise (exportée pour la rotation des clés). */
export function checkpointAad(organizationId: string, runId: string, key: string, ...parts: (string | number)[]) {
  const scope = key ? `${runId}~${key}` : runId;
  return `agent-checkpoint:${organizationId}:${scope}:${parts.join(":")}`;
}

export class EncryptedCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
    private readonly tenant: TenantContext,
  ) {
    super();
  }

  /** thread_id → (run, sous-fil). La clé est bornée et sans séparateur dangereux. */
  private thread(config: RunnableConfig): { runId: string; key: string; threadId: string } {
    const id = config.configurable?.thread_id;
    if (typeof id !== "string") throw new Error("CHECKPOINT_INVALID_THREAD");
    const [runId, ...rest] = id.split("~");
    const key = rest.join("~");
    if (!UUID.test(runId!) || !/^[A-Za-z0-9_~-]{0,200}$/.test(key)) throw new Error("CHECKPOINT_INVALID_THREAD");
    if ((config.configurable?.checkpoint_ns ?? "") !== "") throw new Error("CHECKPOINT_NAMESPACE_UNSUPPORTED");
    return { runId: runId!, key, threadId: id };
  }

  /** AAD liée au run ET au sous-fil (inchangée pour le run lui-même). */
  private aad(thread: { runId: string; key: string }, ...parts: (string | number)[]) {
    return checkpointAad(this.tenant.organizationId, thread.runId, thread.key, ...parts);
  }

  /** Sérialisation LangGraph (type + octets), puis chiffrement. */
  private async seal(client: PoolClient, value: unknown, aad: string) {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    const plain = JSON.stringify({ t: type, d: Buffer.from(bytes).toString("base64") });
    return this.keyring.encrypt(client, this.tenant.organizationId, plain, aad);
  }

  private async open(client: PoolClient, stored: string, aad: string) {
    const { t, d } = JSON.parse(await this.keyring.decrypt(client, this.tenant.organizationId, stored, aad)) as { t: string; d: string };
    return this.serde.loadsTyped(t, new Uint8Array(Buffer.from(d, "base64")));
  }

  private async tuple(client: PoolClient, thread: { runId: string; key: string; threadId: string }, row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = await client.query<WriteRow>(
      `SELECT task_id, idx, channel, value FROM agent_checkpoint_writes
       WHERE run_id = $1 AND thread_key = $2 AND checkpoint_id = $3 ORDER BY task_id, idx`,
      [thread.runId, thread.key, row.checkpoint_id],
    );
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const write of writes.rows) {
      pendingWrites.push([
        write.task_id,
        write.channel,
        await this.open(client, write.value, this.aad(thread, row.checkpoint_id, write.task_id, write.idx)),
      ]);
    }
    const configurable = { thread_id: thread.threadId, checkpoint_ns: "" };
    return {
      config: { configurable: { ...configurable, checkpoint_id: row.checkpoint_id } },
      checkpoint: (await this.open(client, row.checkpoint, this.aad(thread, row.checkpoint_id))) as Checkpoint,
      metadata: (await this.open(client, row.metadata, this.aad(thread, row.checkpoint_id, "metadata"))) as CheckpointMetadata,
      pendingWrites,
      ...(row.parent_id ? { parentConfig: { configurable: { ...configurable, checkpoint_id: row.parent_id } } } : {}),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread = this.thread(config);
    const checkpointId = getCheckpointId(config);
    return withTenant(this.pool, this.tenant, async (client) => {
      const result = await client.query<CheckpointRow>(
        checkpointId
          ? `SELECT checkpoint_id, parent_id, checkpoint, metadata FROM agent_checkpoints WHERE run_id = $1 AND thread_key = $2 AND checkpoint_id = $3`
          : `SELECT checkpoint_id, parent_id, checkpoint, metadata FROM agent_checkpoints WHERE run_id = $1 AND thread_key = $2
             ORDER BY checkpoint_id DESC LIMIT 1`,
        checkpointId ? [thread.runId, thread.key, checkpointId] : [thread.runId, thread.key],
      );
      const row = result.rows[0];
      return row ? this.tuple(client, thread, row) : undefined;
    });
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const thread = this.thread(config);
    const before = options.before?.configurable?.checkpoint_id as string | undefined;
    const tuples = await withTenant(this.pool, this.tenant, async (client) => {
      const result = await client.query<CheckpointRow>(
        `SELECT checkpoint_id, parent_id, checkpoint, metadata FROM agent_checkpoints
         WHERE run_id = $1 AND thread_key = $2 AND ($3::text IS NULL OR checkpoint_id < $3)
         ORDER BY checkpoint_id DESC LIMIT 200`,
        [thread.runId, thread.key, before ?? null],
      );
      const found: CheckpointTuple[] = [];
      for (const row of result.rows) {
        const item = await this.tuple(client, thread, row);
        const metadata = (item.metadata ?? {}) as Record<string, unknown>;
        if (options.filter && !Object.entries(options.filter).every(([key, value]) => metadata[key] === value)) continue;
        found.push(item);
        if (options.limit !== undefined && found.length >= options.limit) break;
      }
      return found;
    });
    yield* tuples;
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const thread = this.thread(config);
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null;
    await withTenant(this.pool, this.tenant, async (client) => {
      await client.query(
        `INSERT INTO agent_checkpoints (organization_id, user_id, run_id, thread_key, checkpoint_id, parent_id, checkpoint, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (run_id, thread_key, checkpoint_id) DO NOTHING`,
        [
          this.tenant.organizationId,
          this.tenant.userId,
          thread.runId,
          thread.key,
          checkpoint.id,
          parentId,
          await this.seal(client, checkpoint, this.aad(thread, checkpoint.id)),
          await this.seal(client, metadata, this.aad(thread, checkpoint.id, "metadata")),
        ],
      );
    });
    return { configurable: { thread_id: thread.threadId, checkpoint_ns: "", checkpoint_id: checkpoint.id } };
  }

  /**
   * Résultat d'une tâche (ex. un appel d'outil) avant la fin de l'étape. Écritures
   * ordinaires : la première l'emporte (une tâche terminée ne se réécrit pas) ;
   * écritures spéciales (erreur, interruption, index négatif) : remplacées.
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const thread = this.thread(config);
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!checkpointId) throw new Error("CHECKPOINT_MISSING_ID");
    await withTenant(this.pool, this.tenant, async (client) => {
      for (const [index, [channel, value]] of writes.entries()) {
        const idx = WRITES_IDX_MAP[channel] ?? index;
        const sealed = await this.seal(client, value, this.aad(thread, checkpointId, taskId, idx));
        if (idx < 0) {
          await client.query(
            `DELETE FROM agent_checkpoint_writes WHERE run_id = $1 AND thread_key = $2 AND checkpoint_id = $3 AND task_id = $4 AND idx = $5`,
            [thread.runId, thread.key, checkpointId, taskId, idx],
          );
        }
        await client.query(
          `INSERT INTO agent_checkpoint_writes (organization_id, user_id, run_id, thread_key, checkpoint_id, task_id, idx, channel, value)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (run_id, thread_key, checkpoint_id, task_id, idx) DO NOTHING`,
          [this.tenant.organizationId, this.tenant.userId, thread.runId, thread.key, checkpointId, taskId, idx, channel, sealed],
        );
      }
    });
  }

  /** Fin du run : points de reprise effacés (minimisation des données). */
  /** Run : tout est effacé, sous-fils compris ; sous-fil : seulement lui. */
  async deleteThread(threadId: string): Promise<void> {
    const thread = this.thread({ configurable: { thread_id: threadId } });
    await withTenant(this.pool, this.tenant, async (client) => {
      if (!thread.key) {
        await client.query("DELETE FROM agent_checkpoint_writes WHERE run_id = $1", [thread.runId]);
        await client.query("DELETE FROM agent_checkpoints WHERE run_id = $1", [thread.runId]);
        return;
      }
      await client.query("DELETE FROM agent_checkpoint_writes WHERE run_id = $1 AND thread_key = $2", [thread.runId, thread.key]);
      await client.query("DELETE FROM agent_checkpoints WHERE run_id = $1 AND thread_key = $2", [thread.runId, thread.key]);
    });
  }
}
