import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { detectFile } from "../attachments/detect.js";
import { makePdf } from "../attachments/fixtures.js";
import { PostgresAttachmentStore } from "../attachments/store.js";
import { defaultAvatar } from "../agents/profile.js";
import { PostgresAgentStore } from "../agents/store.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { MAX_PRESETS, PostgresPresetStore } from "../presets/store.js";
import { PostgresProjectStore } from "../projects/store.js";
import { MemberRuleError, PostgresMemberStore, provisionIdentity } from "./members.js";
import { PostgresPreferencesStore } from "./preferences.js";
import { PostgresSettingsStore } from "./settings.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Espace de travail : RLS, fonctions SQL et chiffrement", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let keyring: OrganizationKeyring;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const ownerA = randomUUID();
  const adminA = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const tenant = (userId: string, organizationId = orgA) => ({ userId, organizationId });
  const issuer = `http://idp.test/${randomUUID()}`;
  const alias = `acme-${randomUUID().slice(0, 8)}`;
  const emails: string[] = [];

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [orgA, orgB]);
    for (const id of [ownerA, adminA, memberA, memberB]) {
      emails.push(`${id}@test.local`);
      await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@test.local`]);
    }
    await owner.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES
         ($1, $3, 'owner'), ($1, $4, 'admin'), ($1, $5, 'member'), ($2, $6, 'member')`,
      [orgA, orgB, ownerA, adminA, memberA, memberB],
    );
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
    await owner.query("DELETE FROM users WHERE lower(email) = ANY($1) OR email LIKE $2", [emails, `%@${alias}.test`]);
    await pool.end();
    await owner.end();
  });

  describe("réglages et consommation", () => {
    it("lit les valeurs par défaut, enregistre et isole les réglages", async () => {
      const settings = new PostgresSettingsStore(pool);
      assert.equal((await settings.get(tenant(adminA))).monthlyTokenLimit, null);

      await settings.update(tenant(adminA), {
        allowedProviders: ["mistral", "anthropic"],
        monthlyTokenLimit: 10_000,
        providerTokenLimits: { anthropic: 2_000 },
        embeddingProvider: "mistral",
        linksEnabled: false,
        linkDomains: ["docs.example.com"],
        tools: ["search_knowledge"],
        toolLimits: { code: 50, web: 200 },
        modelRouting: { fast: { provider: "mistral", model: "mistral-small-latest" }, strong: { provider: "anthropic", model: "claude-opus-5-5" } },
        sensitiveData: "off",
        pseudonymize: true,
      });
      const saved = await settings.get(tenant(memberA));
      assert.deepEqual(saved.tools, ["search_knowledge"]);
      assert.deepEqual(saved.toolLimits, { code: 50, web: 200 });
      assert.equal(saved.modelRouting?.strong.model, "claude-opus-5-5");
      assert.equal(saved.sensitiveData, "off");
      assert.equal(saved.pseudonymize, true);
      // Appels d'outils : comptés pour l'organisation, invisibles des autres.
      await settings.recordTool(tenant(memberA), "code");
      await settings.recordTool(tenant(adminA), "code");
      await settings.recordTool(tenant(memberA), "web");
      assert.deepEqual(await settings.toolUsage(tenant(adminA)), { code: 2, web: 1 });
      assert.deepEqual(saved.allowedProviders, ["mistral", "anthropic"]);
      assert.deepEqual(saved.providerTokenLimits, { anthropic: 2_000 });
      assert.equal(saved.embeddingProvider, "mistral");
      assert.equal(saved.linksEnabled, false);
      assert.deepEqual(saved.linkDomains, ["docs.example.com"]);
      assert.equal((await settings.get(tenant(memberB, orgB))).monthlyTokenLimit, null);
      assert.deepEqual(await settings.toolUsage(tenant(memberB, orgB)), {});
    });

    it("la base refuse un fournisseur inconnu", async () => {
      await assert.rejects(
        withTenant(pool, tenant(adminA), (client) =>
          client.query(
            "UPDATE organization_settings SET allowed_providers = ARRAY['pirate'] WHERE organization_id = $1",
            [orgA],
          ),
        ),
        /organization_settings_providers_check/,
      );
    });

    it("cumule la consommation par fournisseur et par membre", async () => {
      const settings = new PostgresSettingsStore(pool);
      await settings.record(tenant(memberA), "mistral", { inputTokens: 100, outputTokens: 50 });
      await settings.record(tenant(memberA), "mistral", { inputTokens: 10, outputTokens: 5 });
      await settings.record(tenant(adminA), "anthropic", { inputTokens: 1, outputTokens: 1 });

      const usage = await settings.usage(tenant(memberA));
      assert.deepEqual(usage.total, { inputTokens: 111, outputTokens: 56 });
      assert.deepEqual(usage.mine, { inputTokens: 110, outputTokens: 55 });
      assert.deepEqual(usage.byProvider.mistral, { inputTokens: 110, outputTokens: 55 });
      assert.equal((await settings.usage(tenant(memberB, orgB))).total.inputTokens, 0);

      const byMember = await settings.usageByMember(tenant(adminA));
      assert.equal(byMember.find((row) => row.userId === memberA)?.tokens, 165);
    });
  });

  describe("membres (fonctions SECURITY DEFINER)", () => {
    const members = () => new PostgresMemberStore(pool);

    it("un admin change le rôle d'un membre ; personne ne change le sien", async () => {
      await members().setRole(tenant(adminA), memberA, "reader");
      assert.equal((await members().list(tenant(adminA))).find((m) => m.userId === memberA)?.role, "reader");
      await assert.rejects(members().setRole(tenant(adminA), adminA, "owner"), (error: MemberRuleError) => error.code === "SELF_CHANGE_FORBIDDEN");
      await members().setRole(tenant(adminA), memberA, "member");
    });

    it("seul un owner nomme ou modifie un owner ; un membre ne gère rien", async () => {
      await assert.rejects(members().setRole(tenant(adminA), memberA, "owner"), (error: MemberRuleError) => error.code === "FORBIDDEN");
      await assert.rejects(members().setRole(tenant(adminA), ownerA, "member"), (error: MemberRuleError) => error.code === "FORBIDDEN");
      await assert.rejects(members().setRole(tenant(memberA), adminA, "reader"), (error: MemberRuleError) => error.code === "FORBIDDEN");
    });

    it("impossible d'agir sur un membre d'une autre organisation", async () => {
      await assert.rejects(members().setRole(tenant(adminA), memberB, "reader"), (error: MemberRuleError) => error.code === "MEMBER_NOT_FOUND");
      await assert.rejects(members().remove(tenant(adminA), memberB), (error: MemberRuleError) => error.code === "MEMBER_NOT_FOUND");
    });

    it("le rôle applicatif ne peut pas appeler la fonction de garde directement ni modifier la table", async () => {
      await assert.rejects(pool.query("SELECT snowfall_member_guard($1, 'owner')", [memberA]), /permission denied/);
      await assert.rejects(pool.query("UPDATE organization_members SET role = 'owner'"), /permission denied/);
    });

    it("la liaison SSO est réservée aux owners", async () => {
      await assert.rejects(members().setSso(tenant(adminA), alias, "member"), (error: MemberRuleError) => error.code === "FORBIDDEN");
      await members().setSso(tenant(ownerA), alias, "reader");
      assert.deepEqual((await members().organization(tenant(memberA))).sso, { alias, defaultRole: "reader" });
    });
  });

  describe("provisionnement à la connexion", () => {
    it("rattache une invitation à un e-mail vérifié, une seule fois", async () => {
      const email = `invite-${randomUUID().slice(0, 6)}@${alias}.test`;
      await new PostgresMemberStore(pool).invite(tenant(adminA), email.toUpperCase(), "reader");

      const refused = await provisionIdentity(pool, { issuer, subject: "kc-1", email, emailVerified: false, ssoAliases: [] });
      assert.equal(refused.userId, null);

      const accepted = await provisionIdentity(pool, { issuer, subject: "kc-1", email, emailVerified: true, ssoAliases: [] });
      assert.ok(accepted.userId);
      assert.equal(accepted.joined, 1);
      const role = await owner.query("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2", [orgA, accepted.userId]);
      assert.equal(role.rows[0]?.role, "reader");
      assert.equal((await new PostgresMemberStore(pool).invitations(tenant(adminA))).some((item) => item.email === email), false);

      const again = await provisionIdentity(pool, { issuer, subject: "kc-1", email, emailVerified: true, ssoAliases: [] });
      assert.equal(again.userId, accepted.userId);
      assert.equal(again.joined, 0);
    });

    it("rattache un membre SSO de l'organisation Keycloak liée, avec le rôle par défaut", async () => {
      const email = `sso-${randomUUID().slice(0, 6)}@${alias}.test`;
      const result = await provisionIdentity(pool, { issuer, subject: "kc-sso", email, emailVerified: true, ssoAliases: [alias] });
      assert.ok(result.userId);
      const role = await owner.query("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2", [orgA, result.userId]);
      assert.equal(role.rows[0]?.role, "reader");
    });

    it("refuse une identité sans invitation ni SSO, et ne relie jamais un compte déjà lié", async () => {
      const stranger = await provisionIdentity(pool, { issuer, subject: "kc-x", email: `x@${alias}.test`, emailVerified: true, ssoAliases: ["inconnu"] });
      assert.equal(stranger.userId, null);

      // ownerA a déjà une identité : un autre sujet avec son e-mail ne prend pas son compte.
      await owner.query("INSERT INTO external_identities (issuer, subject, user_id) VALUES ($1, 'kc-owner', $2)", [issuer, ownerA]);
      await new PostgresMemberStore(pool).invite(tenant(adminA), `${ownerA}@test.local`, "member").catch(() => undefined);
      const takeover = await provisionIdentity(pool, { issuer, subject: "kc-attaquant", email: `${ownerA}@test.local`, emailVerified: true, ssoAliases: [] });
      assert.equal(takeover.userId, null);
    });

    it("les invitations sont isolées par organisation", async () => {
      await withTenant(pool, tenant(memberB, orgB), async (client) => {
        const visible = await client.query("SELECT 1 FROM organization_invitations WHERE organization_id = $1", [orgA]);
        assert.equal(visible.rowCount, 0);
      });
    });
  });

  describe("projets, pièces jointes et conversations", () => {
    it("projet chiffré, privé, et sa suppression garde les conversations", async () => {
      const projects = new PostgresProjectStore(pool, keyring);
      const conversations = new PostgresConversationStore(pool, keyring);
      const project = await projects.create(tenant(memberA), "Projet confidentiel");
      const conversation = await conversations.create(tenant(memberA), undefined, undefined, project.id);
      assert.equal((await projects.list(tenant(memberA)))[0]?.conversationCount, 1);
      assert.equal((await projects.list(tenant(adminA))).length, 0);

      const raw = await withTenant(owner, tenant(memberA), (client) => client.query("SELECT name FROM projects WHERE id = $1", [project.id]));
      assert.ok(!raw.rows[0].name.includes("confidentiel"));

      await assert.rejects(conversations.create(tenant(adminA), undefined, undefined, project.id), /PROJECT_NOT_FOUND/);
      await projects.delete(tenant(memberA), project.id);
      assert.equal((await conversations.get(tenant(memberA), conversation.id))?.projectId, null);
    });

    it("pièce jointe chiffrée au repos, liée au message, invisible des autres", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const attachments = new PostgresAttachmentStore(pool, keyring);
      const conversation = await conversations.create(tenant(memberA));
      const bytes = makePdf("Salaire 4200");
      const meta = await attachments.create(tenant(memberA), conversation.id, {
        name: "paie.pdf",
        file: detectFile(bytes, "paie.pdf")!,
        bytes,
        text: "Salaire 4200",
      });
      assert.ok(meta);

      const raw = await withTenant(owner, tenant(memberA), (client) =>
        client.query("SELECT name, content, extracted_text FROM attachments WHERE id = $1", [meta.id]),
      );
      assert.ok(!JSON.stringify(raw.rows[0]).includes("Salaire"));
      assert.ok(!JSON.stringify(raw.rows[0]).includes("paie"));

      assert.equal(await attachments.content(tenant(adminA), meta.id), null);
      assert.equal(await attachments.create(tenant(adminA), conversation.id, { name: "x", file: detectFile(bytes, "x.pdf")!, bytes, text: "" }), null);

      const exchange = await conversations.appendExchange(tenant(memberA), conversation.id, "Résume", "OK", { attachmentIds: [meta.id] });
      assert.equal(exchange?.userMessage.attachments?.[0]?.name, "paie.pdf");
      const messages = await conversations.getMessages(tenant(memberA), conversation.id);
      assert.equal(messages?.[0]?.attachments?.[0]?.id, meta.id);
      assert.equal((await attachments.forModel(tenant(memberA), conversation.id, [meta.id])).get(meta.id)?.kind, "document");
      assert.equal(await attachments.delete(tenant(memberA), meta.id), false);
    });

    it("modifier tronque la suite ; régénérer remplace la dernière réponse ; recherche déchiffrée", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const conversation = await conversations.create(tenant(memberA));
      await conversations.appendExchange(tenant(memberA), conversation.id, "Première question", "R1");
      await conversations.appendExchange(tenant(memberA), conversation.id, "Seconde question", "R2");
      const before = (await conversations.getMessages(tenant(memberA), conversation.id))!;

      await conversations.appendExchange(tenant(memberA), conversation.id, "Seconde, reformulée", "R2 bis", {
        replaceFromMessageId: before[2]!.id,
      });
      const edited = (await conversations.getMessages(tenant(memberA), conversation.id))!;
      assert.deepEqual(edited.map((message) => message.content), ["Première question", "R1", "Seconde, reformulée", "R2 bis"]);

      assert.equal(await conversations.replaceLastAssistant(tenant(memberA), conversation.id, edited[1]!.id, "x"), null);
      await conversations.replaceLastAssistant(tenant(memberA), conversation.id, edited[3]!.id, "R2 ter");
      assert.equal((await conversations.getMessages(tenant(memberA), conversation.id))!.at(-1)?.content, "R2 ter");

      const hits = await conversations.search(tenant(memberA), "REFORMULEE");
      assert.equal(hits[0]?.id, conversation.id);
      assert.match(hits[0]?.snippet ?? "", /reformulée/);
      assert.equal((await conversations.search(tenant(adminA), "reformulée")).length, 0);
    });

    it("modèle choisi : changeable tant que la conversation est vide, exclusif avec un agent", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const agents = new PostgresAgentStore(pool, keyring);
      const model = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;
      const agent = await agents.create(tenant(memberA), {
        name: "Juriste",
        avatar: defaultAvatar,
        instructions: "",
        provider: "mistral",
        model: "mistral-small-latest",
      });

      const conversation = await conversations.create(tenant(memberA), undefined, undefined, undefined, model);
      assert.deepEqual((await conversations.get(tenant(memberA), conversation.id))?.model, model);

      const toAgent = await conversations.update(tenant(memberA), conversation.id, { selection: { agentId: agent.id, model: null } });
      assert.equal(toAgent?.agentId, agent.id);
      assert.equal(toAgent?.model, null);
      assert.equal(await conversations.update(tenant(memberB, orgB), conversation.id, { selection: { agentId: null, model } }), null);

      // La base refuse un agent ET un modèle, ou un fournisseur inconnu.
      for (const [provider, agentId] of [["anthropic", agent.id], ["pirate", null]] as const) {
        await assert.rejects(
          withTenant(pool, tenant(memberA), (client) =>
            client.query(
              "UPDATE conversations SET agent_id = $2, model_provider = $3, model_id = 'x' WHERE id = $1",
              [conversation.id, agentId, provider],
            ),
          ),
          /conversations_model_check/,
        );
      }

      await conversations.update(tenant(memberA), conversation.id, { selection: { agentId: null, model } });
      await conversations.appendExchange(tenant(memberA), conversation.id, "Bonjour", "Salut", { author: `model:${model.provider}:${model.model}` });
      // Conversation commencée : on peut changer d'agent ; chaque réponse garde son auteur.
      const switched = await conversations.update(tenant(memberA), conversation.id, { selection: { agentId: agent.id, model: null } });
      assert.equal(switched?.agentId, agent.id);
      const [, answer] = (await conversations.getMessages(tenant(memberA), conversation.id))!;
      assert.equal(answer!.author, `model:${model.provider}:${model.model}`);
      await agents.delete(tenant(memberA), agent.id);
    });

    it("préférences par membre", async () => {
      const preferences = new PostgresPreferencesStore(pool, keyring);
      assert.equal((await preferences.get(tenant(memberA))).locale, null);
      const saved = { locale: "en" as const, sendOnEnter: false, reduceMotion: "on" as const, memory: true, theme: "light" as const, instructions: "Je suis juriste ; réponds en points courts." };
      await preferences.update(tenant(memberA), saved);
      assert.deepEqual(await preferences.get(tenant(memberA)), saved);
      assert.equal((await preferences.get(tenant(adminA))).locale, null);
      // Instructions personnalisées : chiffrées au repos.
      const raw = await withTenant(pool, tenant(memberA), (client) => client.query("SELECT instructions_enc FROM user_preferences WHERE user_id = $1", [memberA]));
      assert.ok(!JSON.stringify(raw.rows).includes("juriste"));
    });

    it("réglages, archive et étiquettes d'une conversation : chiffrés, bornés par la base", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const conversation = await conversations.create(tenant(memberA), "Dossier");
      await conversations.appendExchange(tenant(memberA), conversation.id, "Question", "Réponse");
      const filed = await conversations.update(tenant(memberA), conversation.id, {
        settings: { creativity: "precise", length: "concise", instructions: "Cite les articles du Code civil." },
        archived: true,
        tags: ["Client Durand", "Urgent"],
      });
      assert.deepEqual(filed?.settings, { creativity: "precise", length: "concise", instructions: "Cite les articles du Code civil." });
      assert.equal(filed?.archived, true);
      assert.deepEqual(filed?.tags, ["Client Durand", "Urgent"]);
      assert.deepEqual((await conversations.list(tenant(memberA))).find((item) => item.id === conversation.id)?.tags, ["Client Durand", "Urgent"]);
      // Au repos : ni les instructions ni les étiquettes en clair.
      const raw = await withTenant(pool, tenant(memberA), (client) => client.query("SELECT instructions, tags FROM conversations WHERE id = $1", [conversation.id]));
      assert.ok(!/Code civil|Durand/.test(JSON.stringify(raw.rows)));
      // Un autre membre ne voit ni ne modifie rien.
      assert.equal(await conversations.update(tenant(adminA), conversation.id, { archived: false }), null);
      // La base refuse une valeur hors liste, du texte en clair, une temporaire archivée.
      const write = (sql: string, id = conversation.id) => withTenant(pool, tenant(memberA), (client) => client.query(sql, [id]));
      await assert.rejects(write("UPDATE conversations SET creativity = 'wild' WHERE id = $1"), /conversations_settings_check/);
      await assert.rejects(write("UPDATE conversations SET tags = '[\"clair\"]' WHERE id = $1"), /conversations_tags_encrypted_check/);
      await assert.rejects(write("UPDATE conversations SET instructions = 'clair' WHERE id = $1"), /conversations_instructions_encrypted_check/);
      const temporary = await conversations.create(tenant(memberA), undefined, undefined, undefined, undefined, { temporary: true });
      await assert.rejects(write("UPDATE conversations SET archived = true WHERE id = $1", temporary.id), /conversations_temporary_unfiled_check/);
      // Retour aux réglages de l'agent, désarchivage, étiquettes retirées.
      const cleared = await conversations.update(tenant(memberA), conversation.id, { settings: {}, archived: false, tags: [] });
      assert.equal(cleared?.settings, undefined);
      assert.equal(cleared?.archived, undefined);
      assert.equal(cleared?.tags, undefined);
    });

    it("continuer : la suite s'ajoute à la réponse inachevée, chiffrée, seulement en fin de branche", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const conversation = await conversations.create(tenant(memberA), "Étapes");
      const exchange = await conversations.appendExchange(tenant(memberA), conversation.id, "Quelles étapes ?", "1. lire, 2. ", { incomplete: true });
      const answer = exchange!.assistantMessage;
      assert.equal(answer.incomplete, true);
      assert.equal((await conversations.getMessages(tenant(memberA), conversation.id))!.at(-1)!.incomplete, true);

      // Un autre membre ne peut rien ajouter.
      assert.equal(await conversations.extendAssistant(tenant(adminA), conversation.id, answer.id, "piège", false), null);
      const extended = await conversations.extendAssistant(tenant(memberA), conversation.id, answer.id, "comprendre, 3. agir.", false);
      assert.equal(extended?.content, "1. lire, 2. comprendre, 3. agir.");
      assert.equal(extended?.incomplete, undefined);
      const [, stored] = (await conversations.getMessages(tenant(memberA), conversation.id))!;
      assert.equal(stored!.content, "1. lire, 2. comprendre, 3. agir.");
      assert.equal(stored!.incomplete, undefined);
      const raw = await withTenant(pool, tenant(memberA), (client) => client.query("SELECT content FROM messages WHERE id = $1", [answer.id]));
      assert.ok(!JSON.stringify(raw.rows).includes("comprendre"));

      // La conversation a avancé : l'ancienne réponse n'est plus en fin de branche.
      await conversations.appendExchange(tenant(memberA), conversation.id, "Et ensuite ?", "Fin.");
      assert.equal(await conversations.extendAssistant(tenant(memberA), conversation.id, answer.id, "trop tard", false), null);
    });

    it("bifurquer : copie de la branche affichée jusqu'au message, rechiffrée, sensible si l'originale l'est", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const conversation = await conversations.create(tenant(memberA), "Contrat");
      await conversations.update(tenant(memberA), conversation.id, { settings: { length: "concise", instructions: "Cite les clauses." }, tags: ["Client"] });
      const sources = [{ n: 1, name: "contrat.pdf", excerpt: "Article 4" }] as never;
      await conversations.appendExchange(tenant(memberA), conversation.id, "Durée ?", "Trois ans [1].", { sources, author: "model:mistral:mistral-small-latest" });
      const second = await conversations.appendExchange(tenant(memberA), conversation.id, "Résiliation ?", "Préavis de trois mois.");
      // Une autre version de la dernière réponse : seule la branche affichée est copiée.
      await conversations.replaceLastAssistant(tenant(memberA), conversation.id, second!.assistantMessage.id, "Préavis d'un mois.");
      await conversations.markSensitive(tenant(memberA), conversation.id);
      const original = (await conversations.getMessages(tenant(memberA), conversation.id))!;

      assert.equal(await conversations.fork(tenant(adminA), conversation.id, original[1]!.id), null);
      const copy = await conversations.fork(tenant(memberA), conversation.id, original[3]!.id);
      assert.ok(copy && copy.id !== conversation.id);
      assert.equal(copy.title, "Contrat");
      assert.equal(copy.sensitive, true);
      assert.deepEqual(copy.settings, { length: "concise", instructions: "Cite les clauses." });
      assert.equal(copy.tags, undefined);
      const copied = (await conversations.getMessages(tenant(memberA), copy.id))!;
      assert.deepEqual(copied.map((item) => item.content), ["Durée ?", "Trois ans [1].", "Résiliation ?", "Préavis d'un mois."]);
      assert.deepEqual(copied[1]!.sources, original[1]!.sources);
      assert.equal(copied[1]!.author, "model:mistral:mistral-small-latest");
      assert.ok(copied.every((item) => !item.branch));
      // Rechiffré sous les identifiants de la copie : rien en clair, rien de partagé avec l'originale.
      const raw = await withTenant(pool, tenant(memberA), (client) => client.query("SELECT content FROM messages WHERE conversation_id = $1", [copy.id]));
      assert.ok(!/Durée|Préavis/.test(JSON.stringify(raw.rows)));
      assert.equal(await conversations.fork(tenant(memberA), conversation.id, randomUUID()), null);
      const temporary = await conversations.create(tenant(memberA), undefined, undefined, undefined, undefined, { temporary: true });
      const ephemeral = await conversations.appendExchange(tenant(memberA), temporary.id, "x", "y");
      await assert.rejects(conversations.fork(tenant(memberA), temporary.id, ephemeral!.assistantMessage.id), /TEMPORARY/);
    });

    it("mes fichiers : envoyés seulement ; réutilisés par copie rechiffrée ; la sensibilité suit le fichier", async () => {
      const conversations = new PostgresConversationStore(pool, keyring);
      const attachments = new PostgresAttachmentStore(pool, keyring);
      const bytes = makePdf("Bulletin de paie");
      const file = detectFile(bytes, "paie.pdf")!;
      const source = await conversations.create(tenant(memberA), "Paie");
      const sent = (await attachments.create(tenant(memberA), source.id, { name: "paie.pdf", file, bytes, text: "Bulletin de paie" }))!;
      const draft = (await attachments.create(tenant(memberA), source.id, { name: "brouillon.pdf", file, bytes, text: "x" }))!;
      await conversations.appendExchange(tenant(memberA), source.id, "Lis", "Lu.", { attachmentIds: [sent.id] });
      await conversations.markSensitive(tenant(memberA), source.id);
      const temporary = await conversations.create(tenant(memberA), undefined, undefined, undefined, undefined, { temporary: true });
      const ephemeral = (await attachments.create(tenant(memberA), temporary.id, { name: "ephemere.pdf", file, bytes, text: "x" }))!;
      await conversations.appendExchange(tenant(memberA), temporary.id, "Lis", "Lu.", { attachmentIds: [ephemeral.id] });

      // Liste : envoyés seulement, jamais ceux d'une temporaire, jamais ceux d'un autre.
      const mine = await attachments.library(tenant(memberA));
      assert.ok(mine.some((item) => item.id === sent.id && item.conversationId === source.id && item.name === "paie.pdf"));
      assert.ok(!mine.some((item) => item.id === draft.id || item.id === ephemeral.id));
      assert.ok(!(await attachments.library(tenant(adminA))).some((item) => item.id === sent.id));

      // Copie dans une autre conversation : nouvel identifiant, contenu identique, rechiffré.
      const target = await conversations.create(tenant(memberA), "Analyse");
      assert.equal(await attachments.copy(tenant(adminA), sent.id, target.id), null);
      assert.equal(await attachments.copy(tenant(memberA), ephemeral.id, target.id), null);
      const copied = (await attachments.copy(tenant(memberA), sent.id, target.id))!;
      assert.notEqual(copied.attachment.id, sent.id);
      assert.equal(copied.attachment.messageId, null);
      assert.equal(copied.sensitive, true);
      assert.equal((await conversations.get(tenant(memberA), target.id))?.sensitive, true);
      assert.deepEqual((await attachments.content(tenant(memberA), copied.attachment.id))?.bytes, bytes);
      const forModel = await attachments.forModel(tenant(memberA), target.id, [copied.attachment.id]);
      assert.deepEqual(forModel.get(copied.attachment.id), { kind: "document", name: "paie.pdf", text: "Bulletin de paie" });
      const raw = await withTenant(pool, tenant(memberA), (client) =>
        client.query("SELECT a.content AS copy, b.content AS original FROM attachments a, attachments b WHERE a.id = $1 AND b.id = $2", [copied.attachment.id, sent.id]),
      );
      assert.notEqual(raw.rows[0].copy, raw.rows[0].original);

      // Suppression depuis « Mes fichiers » : même envoyé ; l'original n'est pas touché par la copie.
      assert.equal(await attachments.remove(tenant(adminA), sent.id), false);
      assert.equal(await attachments.remove(tenant(memberA), copied.attachment.id), true);
      assert.ok(await attachments.content(tenant(memberA), sent.id));
      assert.equal(await attachments.remove(tenant(memberA), sent.id), true);
      assert.equal(await attachments.content(tenant(memberA), sent.id), null);
      assert.equal((await conversations.getMessages(tenant(memberA), source.id))![0]!.content, "Lis");
    });

    it("préréglages : privés (RLS), chiffrés, plafonnés", async () => {
      const presets = new PostgresPresetStore(pool, keyring);
      const preset = await presets.create(tenant(memberA), { name: "Juridique", settings: { creativity: "precise", instructions: "Cite les articles." } });
      assert.deepEqual(preset?.settings, { creativity: "precise", instructions: "Cite les articles." });
      assert.deepEqual((await presets.list(tenant(memberA))).map((item) => item.name), ["Juridique"]);
      assert.deepEqual(await presets.list(tenant(adminA)), []);
      assert.equal(await presets.delete(tenant(adminA), preset!.id), false);
      // Même sans filtre explicite, la RLS cache les préréglages des autres.
      const peek = await withTenant(pool, tenant(adminA), (client) => client.query("SELECT id FROM conversation_presets"));
      assert.equal(peek.rowCount, 0);
      const raw = await withTenant(pool, tenant(memberA), (client) => client.query("SELECT name, instructions FROM conversation_presets"));
      assert.ok(!/Juridique|articles/.test(JSON.stringify(raw.rows)));
      await assert.rejects(
        withTenant(pool, tenant(memberA), (client) => client.query("INSERT INTO conversation_presets (organization_id, user_id, name) VALUES ($1, $2, 'clair')", [orgA, memberA])),
        /conversation_presets_encrypted_check/,
      );
      // Plafond : tenu même avec des créations simultanées.
      const made = await Promise.all(Array.from({ length: MAX_PRESETS + 5 }, (_, index) => presets.create(tenant(memberA), { name: `P${index}`, settings: {} })));
      assert.equal(made.filter(Boolean).length, MAX_PRESETS - 1);
      assert.equal((await presets.list(tenant(memberA))).length, MAX_PRESETS);
    });
  });

  describe("journal d'audit : purge encadrée", () => {
    it("la purge n'atteint que les lignes de plus de 90 jours, et jamais sans l'activer", async () => {
      const old = randomUUID();
      const recent = randomUUID();
      await owner.query(
        `INSERT INTO audit_events (id, event_type, outcome, occurred_at) VALUES
           ($1, 'test.old', 'success', now() - interval '120 days'),
           ($2, 'test.recent', 'success', now() - interval '10 days')`,
        [old, recent],
      );
      await assert.rejects(owner.query("DELETE FROM audit_events WHERE id = $1", [old]), /ajout seul/);

      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL snowfall.audit_purge = 'on'");
        await client.query("DELETE FROM audit_events WHERE id = $1", [old]);
        await assert.rejects(client.query("DELETE FROM audit_events WHERE id = $1", [recent]), /ajout seul/);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await assert.rejects(owner.query("UPDATE audit_events SET outcome = 'failure' WHERE id = $1", [recent]), /ajout seul/);
    });
  });
});
