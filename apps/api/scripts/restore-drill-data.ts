import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresConversationStore } from "../src/conversations/store.js";
import { LocalKeyEncryptionProvider, parseMasterKey } from "../src/crypto/envelope.js";
import { OrganizationKeyring } from "../src/crypto/keyring.js";

// Exercice de restauration (scripts/restore-drill.sh) : données de référence.
//
//   seed   : crée une organisation, un membre et des conversations chiffrées
//            (base jetable), puis écrit leurs identifiants et leur contenu attendu ;
//   verify : relit ces conversations dans la base RESTAURÉE, par l'application
//            (rôle applicatif, RLS active, déchiffrement par la clé maître).
//
// Ne jamais lancer contre une vraie base : refusé hors NODE_ENV=test.

const [mode, file] = process.argv.slice(2);
if (process.env.NODE_ENV !== "test") throw new Error("Réservé à l'exercice (NODE_ENV=test, base jetable).");
if (mode !== "seed" && mode !== "verify") throw new Error("Usage : restore-drill-data.ts seed|verify <fichier>");
const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(parseMasterKey(process.env.SNOWFALL_MASTER_KEY ?? "")));
const app = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresConversationStore(app, keyring);
const fs = await import("node:fs/promises");

type Reference = { organizationId: string; userId: string; conversations: { id: string; question: string; answer: string }[] };

try {
  if (mode === "seed") {
    const owner = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
    const tenant = { organizationId: randomUUID(), userId: randomUUID() };
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'Exercice de restauration')", [tenant.organizationId]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [tenant.userId, `${tenant.userId}@drill.test`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [tenant.organizationId, tenant.userId]);
    await owner.end();
    const reference: Reference = { ...tenant, conversations: [] };
    for (let index = 1; index <= 20; index++) {
      const conversation = await store.create(tenant, `Dossier ${index}`);
      const question = `Question ${index} : plafond de la note de frais ${randomUUID()} ?`;
      const answer = `Réponse ${index} : 120 € par nuit (${randomUUID()}).`;
      await store.appendExchange(tenant, conversation.id, question, answer);
      reference.conversations.push({ id: conversation.id, question, answer });
    }
    await fs.writeFile(file!, JSON.stringify(reference));
    console.log(`drill_seed_ok conversations=${reference.conversations.length}`);
  } else {
    const reference = JSON.parse(await fs.readFile(file!, "utf8")) as Reference;
    let checked = 0;
    for (const expected of reference.conversations) {
      const messages = await store.getMessages(reference, expected.id);
      const contents = (messages ?? []).map((message) => message.content);
      if (contents[0] !== expected.question || contents[1] !== expected.answer) throw new Error(`Conversation ${expected.id} : contenu différent après restauration.`);
      checked++;
    }
    // Un autre membre (RLS) ne voit rien de ces conversations dans la base restaurée.
    const stranger = { organizationId: reference.organizationId, userId: randomUUID() };
    if ((await store.getMessages(stranger, reference.conversations[0]!.id)) !== null) throw new Error("RLS : conversation visible d'un autre membre après restauration.");
    console.log(`drill_verify_ok conversations=${checked} decrypted=yes rls=yes`);
  }
} finally {
  await app.end();
}
