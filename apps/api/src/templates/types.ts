import type { AgentAvatar, AgentProfile } from "../agents/profile.js";
import type { ToolId } from "../agent/catalog.js";
import type { EvalCase } from "../evals/agent-eval.js";

// Modèles d'agents du catalogue Snowfall : un agent prêt à l'emploi, avec ses
// compétences, ses outils, ses connecteurs conseillés et SON jeu d'évaluation.
// Installé, c'est un agent ordinaire de l'utilisateur (copie modifiable) : les
// mêmes routes le créent, avec les mêmes contrôles (injection, outils permis…).

export type TemplateCategory = "rh" | "juridique" | "conformite" | "achats" | "donnees" | "support" | "projet" | "redaction" | "commercial" | "general";

export type TemplateSkill = {
  /** Nom affiché (unique dans le modèle). */
  name: string;
  /** Quand s'en servir : c'est ce que le modèle lit pour décider de la charger. */
  description: string;
  /** Procédure détaillée (chargée à la demande, 20 000 caractères au plus). */
  instructions: string;
  /** Fichiers : références (Markdown) et scripts Python (exécutés dans le bac à sable). */
  files?: { name: string; text: string }[];
};

/** Cas d'évaluation : l'agent (instructions, compétences, outils) vient du modèle. */
export type TemplateEvalCase = Omit<EvalCase, "instructions" | "skills" | "tools" | "category"> & {
  category: EvalCase["category"];
  /** Pourquoi un contrôle est écrit ainsi (pour qui modifie le cas ; ignoré par le banc). */
  note?: string;
  /** Outils de ce cas (par défaut : ceux du modèle que le banc sait simuler). */
  tools?: EvalCase["tools"];
};

export type AgentTemplate = {
  id: string;
  category: TemplateCategory;
  name: string;
  /** Une phrase : à quoi il sert. */
  tagline: string;
  /** Ce qu'il fait, en quelques points (affichés dans le catalogue). */
  capabilities: string[];
  /** Ce qu'il ne fait pas (limites assumées, affichées). */
  limits: string[];
  avatar: AgentAvatar;
  /** Prompt système : rôle, règles, méthode (4 000 caractères au plus). */
  instructions: string;
  tools: ToolId[];
  parameters: AgentProfile["parameters"];
  skills: TemplateSkill[];
  /** Connecteurs du catalogue conseillés (identifiants de mcp/catalog.ts). */
  connectors: string[];
  /** Documents à ajouter à ses connaissances pour qu'il soit vraiment utile. */
  knowledge: string[];
  /** Premières questions proposées. */
  starters: string[];
  /** Spécialistes qu'il consulte (identifiants d'autres modèles), installés avec lui. */
  team?: string[];
  evaluation: {
    cases: TemplateEvalCase[];
    /** Dernière mesure sur un vrai modèle (mise à jour après chaque passage du banc). */
    measured?: { model: string; passed: number; total: number; date: string };
  };
};
