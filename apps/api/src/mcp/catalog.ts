// Catalogue de connecteurs connus : serveurs MCP distants publiés par leurs
// éditeurs (transport « Streamable HTTP »). Un administrateur en ajoute un en un
// clic ; il passe ensuite par le même examen qu'un serveur saisi à la main
// (outils découverts, lecture ou écriture décidée par l'administrateur).
//
// source « vendor » : adresse vérifiée dans la documentation de l'éditeur
// (octobre 2026) ; « directory » : relevée dans un annuaire public, à tester.
// Les adresses changent : l'examen (« Examiner ») confirme qu'elle répond.

export type ConnectorCategory =
  | "google"
  | "microsoft"
  | "productivity"
  | "documents"
  | "communication"
  | "design"
  | "development"
  | "crm"
  | "finance"
  | "meetings"
  | "search"
  | "automation";

export type CatalogConnector = {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  /** {tenant} : identifiant du tenant (Microsoft Entra), saisi par l'administrateur. */
  url: string;
  /** oauth : chacun se connecte avec son compte ; token : jeton d'organisation ; none : ouvert. */
  auth: "oauth" | "token" | "none";
  /** Pas d'enregistrement dynamique : créer une application OAuth chez l'éditeur. */
  needsClient?: true;
  scope?: string;
  tenant?: true;
  /** Préversion de l'éditeur : outils et accès peuvent changer. */
  preview?: true;
  /** L'éditeur n'accepte que les clients qu'il a approuvés. */
  allowlist?: true;
  /** Condition de licence côté éditeur. */
  license?: string;
  source: "vendor" | "directory";
  docs?: string;
  /** Logo (Simple Icons) ; null : vignette à l'initiale, aux couleurs de la marque. */
  icon: string | null;
  color: string;
};

const googleDocs = "https://developers.google.com/workspace/guides/configure-mcp-servers";
const googleScopes = (scopes: string[]) => scopes.map((scope) => `https://www.googleapis.com/auth/${scope}`).join(" ");
const google = (id: string, name: string, host: string, description: string, scopes: string[], icon: string, color: string): CatalogConnector => ({
  id,
  name,
  category: "google",
  description,
  url: `https://${host}/mcp/v1`,
  auth: "oauth",
  needsClient: true,
  scope: googleScopes(scopes),
  preview: true,
  source: "vendor",
  docs: googleDocs,
  icon,
  color,
});

const microsoftDocs = "https://github.com/microsoft/mcp";
const microsoft = (id: string, name: string, server: string, description: string, color: string): CatalogConnector => ({
  id,
  name,
  category: "microsoft",
  description,
  url: `https://agent365.svc.cloud.microsoft/agents/tenants/{tenant}/servers/${server}`,
  auth: "oauth",
  needsClient: true,
  tenant: true,
  preview: true,
  license: "Microsoft Agent 365 (licence Microsoft 365 Copilot selon Microsoft)",
  source: "vendor",
  docs: microsoftDocs,
  icon: null,
  color,
});

export const CONNECTOR_CATALOG: CatalogConnector[] = [
  // ---- Google Workspace (préversion développeur, application OAuth Google Cloud) ----
  google("gmail", "Gmail", "gmailmcp.googleapis.com", "Chercher, lire et rédiger des brouillons d'e-mails.", ["gmail.readonly", "gmail.compose"], "gmail", "#EA4335"),
  google("google-drive", "Google Drive", "drivemcp.googleapis.com", "Chercher et lire les fichiers du Drive.", ["drive.readonly", "drive.file"], "googledrive", "#4285F4"),
  google("google-docs", "Google Docs", "docsmcp.googleapis.com", "Lire et modifier des documents.", ["drive.readonly", "drive.file", "documents.readonly", "documents"], "googledocs", "#4285F4"),
  google("google-sheets", "Google Sheets", "sheetsmcp.googleapis.com", "Lire et modifier des feuilles de calcul.", ["drive.readonly", "drive.file", "spreadsheets.readonly", "spreadsheets"], "googlesheets", "#34A853"),
  google("google-slides", "Google Slides", "slidesmcp.googleapis.com", "Lire et modifier des présentations.", ["drive.readonly", "drive.file", "presentations.readonly", "presentations"], "googleslides", "#FBBC04"),
  google("google-calendar", "Google Agenda", "calendarmcp.googleapis.com", "Consulter les agendas et les disponibilités.", ["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly"], "googlecalendar", "#4285F4"),
  google("google-chat", "Google Chat", "chatmcp.googleapis.com", "Lire les espaces et envoyer des messages.", ["chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.messages.create", "chat.users.readstate"], "googlechat", "#00AC47"),
  google("google-contacts", "Google Contacts", "people.googleapis.com", "Annuaire et contacts.", ["directory.readonly", "userinfo.profile", "contacts.readonly"], "google", "#4285F4"),

  // ---- Microsoft 365 (Agent 365, préversion, tenant Entra) ----
  microsoft("sharepoint-onedrive", "SharePoint et OneDrive", "mcp_ODSPRemoteServer", "Fichiers SharePoint et OneDrive (5 Mo par fichier au plus).", "#0364B8"),
  microsoft("sharepoint-lists", "Listes SharePoint", "mcp_SharePointListsTools", "Sites, bibliothèques et listes SharePoint.", "#038387"),
  microsoft("outlook-mail", "Outlook", "mcp_MailTools", "Lire et rédiger des e-mails Microsoft 365.", "#0078D4"),
  microsoft("outlook-calendar", "Calendrier Outlook", "mcp_CalendarTools", "Événements, invitations et disponibilités.", "#0078D4"),
  microsoft("teams", "Microsoft Teams", "mcp_TeamsServer", "Conversations, canaux et messages Teams.", "#5059C9"),
  microsoft("word", "Microsoft Word", "mcp_WordServer", "Lire, créer et commenter des documents Word.", "#2B579A"),
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    category: "microsoft",
    description: "Documentation officielle Microsoft, à jour.",
    url: "https://learn.microsoft.com/api/mcp",
    auth: "none",
    source: "vendor",
    docs: microsoftDocs,
    icon: null,
    color: "#737373",
  },

  // ---- Gestion de projet et productivité ----
  {
    id: "atlassian",
    name: "Jira et Confluence",
    category: "productivity",
    description: "Tickets Jira, pages Confluence, Jira Service Management, Loom (Atlassian).",
    url: "https://mcp.atlassian.com/v2/mcp",
    auth: "oauth",
    source: "vendor",
    docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    icon: "jira",
    color: "#0052CC",
  },
  { id: "notion", name: "Notion", category: "productivity", description: "Pages et bases Notion.", url: "https://mcp.notion.com/mcp", auth: "oauth", source: "vendor", icon: "notion", color: "#000000" },
  { id: "linear", name: "Linear", category: "productivity", description: "Tickets, projets et cycles Linear.", url: "https://mcp.linear.app/mcp", auth: "oauth", source: "vendor", icon: "linear", color: "#5E6AD2" },
  {
    id: "asana",
    name: "Asana",
    category: "productivity",
    description: "Tâches, projets et objectifs Asana.",
    url: "https://mcp.asana.com/v2/mcp",
    auth: "oauth",
    source: "vendor",
    docs: "https://developers.asana.com/docs/using-asanas-mcp-server",
    icon: "asana",
    color: "#F06A6A",
  },
  { id: "monday", name: "monday.com", category: "productivity", description: "Tableaux, éléments et mises à jour.", url: "https://mcp.monday.com/mcp", auth: "oauth", source: "directory", icon: null, color: "#FF3D57" },
  { id: "clickup", name: "ClickUp", category: "productivity", description: "Tâches, documents et espaces ClickUp.", url: "https://mcp.clickup.com/mcp", auth: "oauth", needsClient: true, source: "directory", icon: "clickup", color: "#7B68EE" },
  { id: "airtable", name: "Airtable", category: "productivity", description: "Bases, tables et enregistrements.", url: "https://mcp.airtable.com/mcp", auth: "oauth", source: "directory", icon: "airtable", color: "#18BFFF" },
  { id: "todoist", name: "Todoist", category: "productivity", description: "Tâches et projets Todoist.", url: "https://ai.todoist.net/mcp", auth: "oauth", source: "directory", icon: "todoist", color: "#E44332" },
  { id: "calendly", name: "Calendly", category: "productivity", description: "Rendez-vous et créneaux.", url: "https://mcp.calendly.com", auth: "oauth", source: "directory", icon: "calendly", color: "#006BFF" },

  // ---- Documents et stockage ----
  { id: "box", name: "Box", category: "documents", description: "Fichiers et dossiers Box.", url: "https://mcp.box.com", auth: "oauth", needsClient: true, source: "directory", icon: "box", color: "#0061D5" },

  // ---- Communication ----
  { id: "slack", name: "Slack", category: "communication", description: "Canaux, messages et recherche Slack (validé par l'admin Slack).", url: "https://mcp.slack.com/mcp", auth: "oauth", needsClient: true, source: "directory", icon: null, color: "#4A154B" },
  { id: "zoom", name: "Zoom", category: "communication", description: "Réunions et enregistrements Zoom.", url: "https://mcp.zoom.us/mcp/zoom/streamable", auth: "oauth", source: "directory", icon: "zoom", color: "#0B5CFF" },

  // ---- Réunions et comptes rendus ----
  { id: "granola", name: "Granola", category: "meetings", description: "Notes de réunion Granola.", url: "https://mcp.granola.ai/mcp", auth: "oauth", source: "directory", icon: null, color: "#3E6B48" },
  { id: "otter", name: "Otter.ai", category: "meetings", description: "Transcriptions de réunions.", url: "https://mcp.otter.ai/mcp", auth: "oauth", source: "directory", icon: null, color: "#1C64F2" },
  { id: "fireflies", name: "Fireflies.ai", category: "meetings", description: "Transcriptions et résumés de réunions.", url: "https://api.fireflies.ai/mcp", auth: "oauth", source: "directory", icon: null, color: "#6F2DBD" },
  { id: "fathom", name: "Fathom", category: "meetings", description: "Enregistrements et notes de réunions.", url: "https://api.fathom.ai/mcp", auth: "oauth", source: "directory", icon: null, color: "#00B37E" },

  // ---- Design ----
  {
    id: "figma",
    name: "Figma",
    category: "design",
    description: "Maquettes et composants Figma.",
    url: "https://mcp.figma.com/mcp",
    auth: "oauth",
    needsClient: true,
    allowlist: true,
    source: "vendor",
    docs: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    icon: "figma",
    color: "#F24E1E",
  },
  { id: "canva", name: "Canva", category: "design", description: "Designs et modèles Canva.", url: "https://mcp.canva.com/mcp", auth: "oauth", source: "directory", icon: null, color: "#00C4CC" },
  { id: "miro", name: "Miro", category: "design", description: "Tableaux blancs Miro.", url: "https://mcp.miro.com/", auth: "oauth", source: "directory", icon: "miro", color: "#FFD02F" },
  { id: "gamma", name: "Gamma", category: "design", description: "Présentations et documents Gamma.", url: "https://mcp.gamma.app/mcp", auth: "oauth", source: "directory", icon: null, color: "#7C3AED" },

  // ---- Développement ----
  {
    id: "github",
    name: "GitHub",
    category: "development",
    description: "Dépôts, tickets et pull requests.",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "oauth",
    needsClient: true,
    source: "vendor",
    docs: "https://github.com/github/github-mcp-server",
    icon: "github",
    color: "#181717",
  },
  { id: "sentry", name: "Sentry", category: "development", description: "Erreurs et performances.", url: "https://mcp.sentry.dev/mcp", auth: "oauth", source: "vendor", icon: "sentry", color: "#362D59" },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "development",
    description: "Comptes, Workers et configuration Cloudflare.",
    url: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
    source: "vendor",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    icon: "cloudflare",
    color: "#F38020",
  },
  {
    id: "cloudflare-docs",
    name: "Documentation Cloudflare",
    category: "development",
    description: "Documentation Cloudflare, à jour.",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "none",
    source: "vendor",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    icon: "cloudflare",
    color: "#F38020",
  },
  { id: "vercel", name: "Vercel", category: "development", description: "Projets et déploiements Vercel.", url: "https://mcp.vercel.com/", auth: "oauth", source: "directory", icon: "vercel", color: "#000000" },
  { id: "supabase", name: "Supabase", category: "development", description: "Bases et projets Supabase.", url: "https://mcp.supabase.com/mcp", auth: "oauth", source: "directory", icon: "supabase", color: "#3FCF8E" },
  { id: "neon", name: "Neon", category: "development", description: "Bases Postgres Neon.", url: "https://mcp.neon.tech/mcp", auth: "oauth", source: "directory", icon: "neon", color: "#00E599" },
  { id: "netlify", name: "Netlify", category: "development", description: "Sites et déploiements Netlify.", url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", source: "directory", icon: "netlify", color: "#00C7B7" },
  { id: "postman", name: "Postman", category: "development", description: "Collections et API Postman.", url: "https://mcp.postman.com/mcp", auth: "oauth", source: "directory", icon: "postman", color: "#FF6C37" },
  { id: "buildkite", name: "Buildkite", category: "development", description: "Pipelines et builds Buildkite.", url: "https://mcp.buildkite.com/mcp", auth: "oauth", source: "directory", icon: "buildkite", color: "#14CC80" },
  { id: "prisma", name: "Prisma Postgres", category: "development", description: "Bases Prisma Postgres.", url: "https://mcp.prisma.io/mcp", auth: "oauth", source: "directory", icon: "prisma", color: "#2D3748" },
  { id: "stack-overflow", name: "Stack Overflow", category: "development", description: "Questions et réponses Stack Overflow.", url: "https://mcp.stackoverflow.com", auth: "oauth", source: "directory", icon: "stackoverflow", color: "#F58025" },
  { id: "hugging-face", name: "Hugging Face", category: "development", description: "Modèles, jeux de données et Spaces.", url: "https://huggingface.co/mcp", auth: "none", source: "directory", icon: "huggingface", color: "#FFD21E" },
  { id: "deepwiki", name: "DeepWiki", category: "development", description: "Documentation des dépôts publics.", url: "https://mcp.deepwiki.com/mcp", auth: "none", source: "directory", icon: null, color: "#2563EB" },
  { id: "aws-knowledge", name: "AWS Knowledge", category: "development", description: "Documentation AWS, à jour.", url: "https://knowledge-mcp.global.api.aws", auth: "none", source: "directory", icon: null, color: "#232F3E" },

  // ---- CRM et support ----
  {
    id: "hubspot",
    name: "HubSpot",
    category: "crm",
    description: "Contacts, entreprises et transactions HubSpot.",
    url: "https://mcp.hubspot.com",
    auth: "oauth",
    needsClient: true,
    source: "vendor",
    docs: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    icon: "hubspot",
    color: "#FF7A59",
  },
  { id: "attio", name: "Attio", category: "crm", description: "CRM Attio.", url: "https://mcp.attio.com/mcp", auth: "oauth", source: "directory", icon: null, color: "#1F2937" },
  { id: "close", name: "Close", category: "crm", description: "Prospects et opportunités Close.", url: "https://mcp.close.com/mcp", auth: "oauth", needsClient: true, source: "directory", icon: null, color: "#2F80ED" },

  // ---- Paiement et finance ----
  { id: "stripe", name: "Stripe", category: "finance", description: "Clients, paiements et abonnements Stripe.", url: "https://mcp.stripe.com", auth: "oauth", source: "directory", icon: "stripe", color: "#635BFF" },
  { id: "ramp", name: "Ramp", category: "finance", description: "Dépenses et cartes Ramp.", url: "https://ramp-mcp-remote.ramp.com/mcp", auth: "oauth", source: "directory", icon: null, color: "#1A1A1A" },

  // ---- Recherche et données ----
  { id: "exa", name: "Exa", category: "search", description: "Recherche web pour agents.", url: "https://mcp.exa.ai/mcp", auth: "none", source: "directory", icon: null, color: "#1F40ED" },
  { id: "wolfram", name: "Wolfram", category: "search", description: "Calcul et données Wolfram|Alpha.", url: "https://agenttools.wolfram.com/mcp", auth: "none", source: "directory", icon: "wolfram", color: "#DD1100" },

  // ---- Automatisation ----
  { id: "zapier", name: "Zapier", category: "automation", description: "Des milliers d'applications via Zapier (clé API).", url: "https://mcp.zapier.com/api/mcp/mcp", auth: "token", source: "directory", icon: "zapier", color: "#FF4F00" },
];

/** Adresse finale d'un connecteur (identifiant de tenant vérifié : un GUID, rien d'autre). */
export function connectorUrl(connector: CatalogConnector, tenant?: string) {
  if (!connector.tenant) return connector.url;
  if (!tenant || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) return null;
  return connector.url.replace("{tenant}", tenant.toLowerCase());
}

/** Connecteur du catalogue correspondant à une adresse (tenant compris), ou null. */
export function catalogIdFor(url: string) {
  for (const connector of CONNECTOR_CATALOG) {
    if (!connector.tenant && connector.url === url) return connector.id;
    if (connector.tenant) {
      const [before, after] = connector.url.split("{tenant}");
      if (url.startsWith(before!) && url.endsWith(after!) && /^[0-9a-f-]{36}$/.test(url.slice(before!.length, url.length - after!.length))) return connector.id;
    }
  }
  return null;
}
