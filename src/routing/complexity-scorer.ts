/**
 * 13-dimension heuristic complexity scorer.
 *
 * Classifies user messages into LIGHT / MEDIUM / HEAVY tiers by evaluating
 * text along multiple independent dimensions.  Runs in < 1 ms with zero
 * external dependencies — pure regex + arithmetic on the message text.
 *
 * Each dimension returns a normalised score roughly in the -1 … +1 range:
 *   negative → simple,  zero → neutral,  positive → complex.
 *
 * The weighted sum is clamped to [-1, 1] and mapped to tiers via the
 * boundaries configured in `routing.scoring.boundaries` (default 0.0 / 0.35).
 */

import type { ScoringResult, Message } from "./types.ts";

// ─── Dimension weights ──────────────────────────────────────────────

const DEFAULT_WEIGHTS: Record<string, number> = {
  messageLength: 0.10,
  codePresence: 0.12,
  questionCount: 0.05,
  technicalDensity: 0.08,
  multiStep: 0.10,
  reasoningDepth: 0.10,
  contextDependency: 0.05,
  structureComplexity: 0.08,
  instructionCount: 0.08,
  domainBreadth: 0.08,
  formattingComplexity: 0.04,
  abstractionLevel: 0.06,
  scopeBreadth: 0.06,
};

// ─── Pre-compiled patterns (module-level, created once) ─────────────

const PAT = {
  /** Unix / Windows file paths with 2+ segments. */
  filePath: /(?:\/[\w.-]+){2,}|(?:[A-Z]:\\[\w.-]+){2,}/g,
  /** Question marks. */
  question: /\?/g,
  /** Sequential / multi-step markers. */
  multiStep: /\b(?:then|after that|next|finally|afterwards|subsequently|step\s+\d+)\b/gi,
  /** Numbered list items (lines starting with digits). */
  numberedItem: /^\s*\d+[.)]\s/gm,
  /** Deep-reasoning verbs. */
  reasoning: /\b(?:explain|analyze|compare|evaluate|why|how|what if|pros?\s+and\s+cons|trade-?off|assess|critique|review|investigate|diagnose|debug|troubleshoot|reason\s+about|walk\s+through|break\s+down)\b/gi,
  /** Context-dependent pronouns / references. */
  contextDep: /\b(?:it|this|that|these|those|the\s+(?:above|previous|earlier|current|following|result|output|error|code|file|function|class|module)|as\s+(?:mentioned|discussed|noted|stated|shown)|referring\s+to|regarding|from\s+above)\b/gi,
  /** Structural / graph terms. */
  structure: /\b(?:recursive|tree|graph|nested|hierarchy|parent.?child|DAG|circular|dependency|chain|inheritance\s+chain|call\s+stack)\b/gi,
  /** Imperative / action verbs. */
  instruction: /\b(?:write|create|implement|build|add|remove|update|delete|refactor|extract|move|rename|fix|change|modify|convert|transform|migrate|integrate|connect|setup|configure|deploy|install|generate|parse|serialize|deserialize|validate|sanitize|optimize|cache|mock|stub|replace|split|merge|wrap|unwrap|inject)\b/gi,
  /** Named technology / framework tokens. */
  domain: /\b(?:React|Vue\.?js|Angular|Svelte|Next\.?js|Nuxt|Node\.?js|Deno|Bun|Python|Java\b|Go\b|Rust|TypeScript|JavaScript|SQL|NoSQL|MongoDB|PostgreSQL|Redis|MySQL|SQLite|Docker|Kubernetes|K8s|AWS|GCP|Azure|Terraform|REST|GraphQL|gRPC|WebSocket|TCP|HTTP|HTML|CSS|SASS|Tailwind|Bootstrap|Webpack|Vite|esbuild|Turborepo|pnpm|npm|yarn|Git|Linux|macOS|Windows|Nginx|Apache|CI\/CD|Ansible|Kafka|RabbitMQ|Elasticsearch|OpenAI|Anthropic|Claude|GPT|LLM|API|SDK|CLI|GUI|SSR|SSG|ISR|ORM|ODM|Prisma|Drizzle|Supabase|Firebase|Vercel|Netlify|Cloudflare)\b/gi,
  /** Structured-data formatting markers (tables, JSON blocks, etc.). */
  formatting: /```(?:json|yaml|xml|toml|csv|html|svg|mermaid)/gi,
  table: /^[ \t]*\|.+\|[ \t]*$/gm,
  /** High-level / abstract concept terms. */
  abstraction: /\b(?:architecture|design\s+pattern|strategy\s+pattern|pattern|principle|paradigm|methodology|framework|approach|concept|abstraction|interface|contract|protocol|standard|best\s+practice|convention|ontology|schema|taxonomy)\b/gi,
  /** Broad-scope markers. */
  scope: /\b(?:entire|all\b|whole|complete|comprehensive|full|end-?to-?end|from\s+scratch|migrate|rewrite|redesign|overhaul|rebuild|restructure|monorepo|microservice|mono-?repo|polyglot)\b/gi,
  /** Low-level / implementation-specific terms. */
  technical: /\b(?:async|await|promise|observable|stream|buffer|thread|mutex|lock|atomic|nullable|generic|polymorphism|inheritance|composition|decorator|middleware|plugin|hook|callback|closure|curry|memo|proxy|reflect|symbol|iterator|generator|wasm|heap|stack|garbage\s+collect|type\s+inference|monad|functor|algebraic|covariant|contravariant|big-?o|time\s+complexity|space\s+complexity|nonce|salt|hash|cipher|token|payload|serialization|deserialization|idempoten|memoize|throttle|debounce)\b/gi,
} as const;

// ─── Helpers ────────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Extract the text content from the last user message only. */
function extractLastUserText(messages: ReadonlyArray<Message>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
      if (parts.length > 0) return parts.join(" ");
    }
  }
  return "";
}

/** Count unique (lower-cased) matches of a global regex. Resets lastIndex. */
function countUnique(text: string, re: RegExp): number {
  re.lastIndex = 0;
  const matches = text.match(re);
  if (!matches) return 0;
  const seen = new Set<string>();
  for (const m of matches) seen.add(m.toLowerCase());
  return seen.size;
}

/** Count all occurrences (not unique) of a global regex. */
function countAll(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return (text.match(re) ?? []).length;
}

// ─── Dimension scorers ──────────────────────────────────────────────

/** D1 – Message length (log-scale). */
function dimMessageLength(text: string): number {
  const len = text.length;
  if (len < 20) return -0.6;
  if (len < 50) return -0.4;
  if (len < 100) return -0.2;
  if (len < 250) return 0.1;
  if (len < 500) return 0.3;
  if (len < 1000) return 0.5;
  return 0.8;
}

/** D2 – Code presence (fenced blocks, inline code, file paths). */
function dimCodePresence(text: string): number {
  let s = 0;

  // Fenced code blocks — count by ``` pairs
  const fenceCount = countAll(text, /```/g);
  const blockCount = Math.floor(fenceCount / 2);
  if (blockCount > 0) s += Math.min(blockCount * 0.5, 1.0);

  // Inline code (`` `...` `` without being a fence)
  const inlineRe = /(?<!`)`([^`\n]+)`(?!`)/g;
  inlineRe.lastIndex = 0;
  const inline = text.match(inlineRe);
  if (inline) s += Math.min(inline.length * 0.15, 0.3);

  // File paths
  const paths = countUnique(text, PAT.filePath);
  if (paths > 0) s += Math.min(paths * 0.2, 0.4);

  return clamp(s - 0.2, -1, 1);
}

/** D3 – Question count. */
function dimQuestionCount(text: string): number {
  const n = countAll(text, PAT.question);
  if (n === 0) return -0.2;
  if (n === 1) return 0.0;
  if (n <= 3) return 0.3;
  return 0.6;
}

/** D4 – Technical jargon density. */
function dimTechnicalDensity(text: string): number {
  const unique = countUnique(text, PAT.technical);
  if (unique === 0) return -0.3;
  const words = text.split(/\s+/).length || 1;
  const density = (unique / words) * 15;
  return clamp(density - 0.4, -0.5, 1.0);
}

/** D5 – Multi-step instruction markers. */
function dimMultiStep(text: string): number {
  const seq = countUnique(text, PAT.multiStep);
  PAT.numberedItem.lastIndex = 0;
  const nums = text.match(PAT.numberedItem);
  const total = seq + (nums ? nums.length : 0);
  if (total === 0) return -0.2;
  if (total === 1) return 0.1;
  if (total <= 3) return 0.4;
  return 0.7;
}

/** D6 – Reasoning / analysis depth. */
function dimReasoningDepth(text: string): number {
  const unique = countUnique(text, PAT.reasoning);
  if (unique === 0) return -0.3;
  if (unique === 1) return 0.1;
  if (unique <= 2) return 0.3;
  return clamp(unique * 0.2, 0, 1.0);
}

/** D7 – Context dependency (pronouns / references to prior conversation). */
function dimContextDependency(text: string, messageCount: number): number {
  const unique = countUnique(text, PAT.contextDep);
  // Single-message conversation with many context refs = ambiguous
  if (messageCount <= 1 && unique >= 3) return 0.6;
  if (unique === 0) return -0.2;
  if (unique <= 2) return -0.1;
  return clamp(unique * 0.15, 0, 0.8);
}

/** D8 – Structural / architectural complexity. */
function dimStructureComplexity(text: string): number {
  const unique = countUnique(text, PAT.structure);
  if (unique === 0) return -0.3;
  if (unique === 1) return 0.1;
  return clamp(unique * 0.3, 0, 1.0);
}

/** D9 – Instruction / action verb count. */
function dimInstructionCount(text: string): number {
  const unique = countUnique(text, PAT.instruction);
  if (unique === 0) return -0.3;
  if (unique === 1) return 0.0;
  if (unique <= 3) return 0.3;
  return 0.6;
}

/** D10 – Domain breadth (distinct technologies mentioned). */
function dimDomainBreadth(text: string): number {
  const unique = countUnique(text, PAT.domain);
  if (unique === 0) return -0.2;
  if (unique === 1) return 0.0;
  if (unique <= 3) return 0.3;
  if (unique <= 5) return 0.5;
  return 0.8;
}

/** D11 – Formatting complexity (structured data blocks). */
function dimFormattingComplexity(text: string): number {
  let s = 0;
  PAT.formatting.lastIndex = 0;
  if (PAT.formatting.test(text)) s += 0.4;
  PAT.table.lastIndex = 0;
  const tables = text.match(PAT.table);
  if (tables && tables.length >= 2) s += 0.3;
  if (s === 0) return -0.2;
  return clamp(s, 0, 0.8);
}

/** D12 – Abstraction level. */
function dimAbstractionLevel(text: string): number {
  const unique = countUnique(text, PAT.abstraction);
  if (unique === 0) return -0.3;
  if (unique === 1) return 0.1;
  if (unique <= 2) return 0.3;
  return clamp(unique * 0.2, 0, 1.0);
}

/** D13 – Scope breadth. */
function dimScopeBreadth(text: string): number {
  const unique = countUnique(text, PAT.scope);
  if (unique === 0) return -0.3;
  if (unique === 1) return 0.1;
  if (unique <= 2) return 0.3;
  return clamp(unique * 0.2, 0, 1.0);
}

// ─── Public API ─────────────────────────────────────────────────────

export interface ScorerConfig {
  /** Custom per-dimension weights. Omitted dimensions default to 0. */
  weights?: Record<string, number>;
}

/**
 * Score the complexity of the last user message across 13 dimensions.
 *
 * Returns a `ScoringResult` whose `score` sits in [-1, 1] and whose
 * `confidence` is derived from the absolute score via sigmoid.
 *
 * Intended to be consumed by `mapScoreToTier()` from `tier-mapper.ts`.
 */
export function scoreComplexity(
  messages: ReadonlyArray<Message>,
  config?: ScorerConfig,
): ScoringResult {
  const text = extractLastUserText(messages);
  if (text.length === 0) {
    return { score: 0, confidence: 0, dimensions: {}, textExcerpt: "" };
  }

  const weights = { ...DEFAULT_WEIGHTS, ...config?.weights };

  const dimensions: Record<string, number> = {
    messageLength: dimMessageLength(text),
    codePresence: dimCodePresence(text),
    questionCount: dimQuestionCount(text),
    technicalDensity: dimTechnicalDensity(text),
    multiStep: dimMultiStep(text),
    reasoningDepth: dimReasoningDepth(text),
    contextDependency: dimContextDependency(text, messages.length),
    structureComplexity: dimStructureComplexity(text),
    instructionCount: dimInstructionCount(text),
    domainBreadth: dimDomainBreadth(text),
    formattingComplexity: dimFormattingComplexity(text),
    abstractionLevel: dimAbstractionLevel(text),
    scopeBreadth: dimScopeBreadth(text),
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const [dim, raw] of Object.entries(dimensions)) {
    const w = weights[dim] ?? 0;
    weightedSum += raw * w;
    totalWeight += w;
  }

  const normalised = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const score = clamp(normalised, -1, 1);
  // Steeper sigmoid: |score| * 6 ensures confidence ≥ 0.7 at |score| ≈ 0.14
  const confidence = sigmoid(Math.abs(score) * 6);

  return {
    score,
    confidence,
    dimensions,
    textExcerpt: text.slice(0, 50),
  };
}
