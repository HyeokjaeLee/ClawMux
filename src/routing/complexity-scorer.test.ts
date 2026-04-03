import { describe, test, expect, beforeAll } from "bun:test";
import { scoreComplexity } from "./complexity-scorer.ts";
import { classifyLocal } from "./local-classifier.ts";
import { mapScoreToTier } from "./tier-mapper.ts";
import type { Message } from "./types.ts";

const DEFAULT_BOUNDARIES = { lightMedium: 0.0, mediumHeavy: 0.35 };
const DEFAULT_CONFIDENCE = 0.7;

function msg(text: string, role = "user"): Message {
  return { role, content: text };
}

async function classify(text: string, messages?: Message[]) {
  const msgs = messages ?? [msg(text)];
  const result = await classifyLocal(msgs);
  return { tier: result.tier, confidence: result.confidence };
}

beforeAll(async () => {
  await classifyLocal([msg("warmup")]);
}, 180_000);

// ─── Basic contract ────────────────────────────────────────────────

describe("scoreComplexity", () => {
  test("returns score in [-1, 1] range", () => {
    const r = scoreComplexity([msg("hello")]);
    expect(r.score).toBeGreaterThanOrEqual(-1);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  test("returns confidence in [0, 1] range", () => {
    const r = scoreComplexity([msg("hello")]);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  test("returns all 13 dimensions", () => {
    const r = scoreComplexity([msg("hello")]);
    expect(Object.keys(r.dimensions)).toHaveLength(13);
  });

  test("returns textExcerpt (first 50 chars)", () => {
    const r = scoreComplexity([msg("hello world")]);
    expect(r.textExcerpt).toBe("hello world");
  });

  test("empty messages → zero score, zero confidence", () => {
    const r = scoreComplexity([]);
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.textExcerpt).toBe("");
  });

  test("only assistant messages → zero score, zero confidence", () => {
    const r = scoreComplexity([msg("I can help!", "assistant")]);
    expect(r.score).toBe(0);
    expect(r.confidence).toBe(0);
  });
});

// ─── LIGHT tier (simple messages) ──────────────────────────────────

describe("LIGHT tier classification", () => {
  test("greeting → LIGHT", async () => {
    const { tier } = await classify("hello");
    expect(tier).toBe("LIGHT");
  });

  test("short confirmation → LIGHT", async () => {
    const { tier } = await classify("yes, go ahead");
    expect(tier).toBe("LIGHT");
  });

  test("thanks → LIGHT", async () => {
    const { tier } = await classify("thanks!");
    expect(tier).toBe("LIGHT");
  });

  test("single factual question → LIGHT or MEDIUM", async () => {
    const { tier } = await classify("what is 2 + 2?");
    // Short factual question could be either LIGHT or low-MEDIUM
    expect(["LIGHT", "MEDIUM"]).toContain(tier);
  });

  test("short affirmation → LIGHT", async () => {
    const { tier } = await classify("ok");
    expect(tier).toBe("LIGHT");
  });

  test("emoji / casual → LIGHT", async () => {
    const { tier } = await classify("👍");
    expect(tier).toBe("LIGHT");
  });
});

// ─── MEDIUM tier (standard coding tasks) ───────────────────────────

describe("MEDIUM tier classification", () => {
  test("standard coding request → MEDIUM", async () => {
    const { tier } = await classify("write a function to sort an array");
    expect(tier).toBe("MEDIUM");
  });

  test("explanation request → MEDIUM", async () => {
    const { tier } = await classify("explain how closures work in JavaScript");
    expect(["MEDIUM", "HEAVY"]).toContain(tier);
  });

  test("single-file fix → LIGHT or MEDIUM", async () => {
    const { tier } = await classify("fix the bug in src/utils/parser.ts where it throws on empty input");
    expect(["LIGHT", "MEDIUM"]).toContain(tier);
  });

  test("moderate code with one code block → MEDIUM", async () => {
    const text = "refactor this function to use async/await:\n```js\nfunction getData() {\n  return fetch(url).then(r => r.json())\n}\n```";
    const { tier } = await classify(text);
    expect(["MEDIUM", "HEAVY"]).toContain(tier);
  });
});

// ─── HEAVY tier (complex tasks) ────────────────────────────────────

describe("HEAVY tier classification", () => {
  test("architecture design → HEAVY", async () => {
    const { tier } = await classify(
      "Design a microservices architecture for an e-commerce platform with user authentication, product catalog, order management, payment processing, and inventory tracking. Consider event-driven communication between services and implement saga pattern for distributed transactions.",
    );
    expect(tier).toBe("HEAVY");
  });

  test("multi-domain complex request → HEAVY", async () => {
    const { tier } = await classify(
      "Analyze the performance bottlenecks in our React frontend that communicates with a PostgreSQL backend through a GraphQL API. Compare the current approach with a REST + Redis caching strategy and evaluate the trade-offs for our specific use case of real-time dashboard updates.",
    );
    expect(tier).toBe("HEAVY");
  });

  test("deep debugging with multiple files → HEAVY", async () => {
    const { tier } = await classify(
      "Debug why the WebSocket connection drops intermittently in production. The issue manifests in src/proxy/pipeline.ts when concurrent requests exceed 50. Check src/config/watcher.ts for race conditions and src/adapters/stream-transformer.ts for backpressure handling. We're running on Kubernetes with Nginx ingress.",
    );
    expect(tier).toBe("HEAVY");
  });

  test("multi-step migration → MEDIUM or HEAVY", async () => {
    const { tier } = await classify(
      "Migrate our entire monorepo from JavaScript to TypeScript step by step: 1) Set up tsconfig for each package 2) Add types to shared utilities 3) Convert React components 4) Update API routes 5) Add strict mode 6) Configure path aliases. Then rewrite the CI/CD pipeline for the new build process.",
    );
    expect(["MEDIUM", "HEAVY"]).toContain(tier);
  });
});

// ─── Dimension-specific tests ──────────────────────────────────────

describe("scoring dimensions", () => {
  test("messageLength: short text scores lower than long text", () => {
    const short = scoreComplexity([msg("hi")]);
    const long = scoreComplexity([msg("a".repeat(800))]);
    expect(short.dimensions.messageLength).toBeLessThan(long.dimensions.messageLength);
  });

  test("codePresence: code blocks increase score", () => {
    const plain = scoreComplexity([msg("sort this")]);
    const withCode = scoreComplexity([msg("sort this:\n```js\nconst a = [3,1,2];\na.sort();\n```")]);
    expect(plain.dimensions.codePresence).toBeLessThan(withCode.dimensions.codePresence);
  });

  test("codePresence: inline code increases score", () => {
    const plain = scoreComplexity([msg("use the function")]);
    const withInline = scoreComplexity([msg("use the `parseJSON` function")]);
    expect(plain.dimensions.codePresence).toBeLessThan(withInline.dimensions.codePresence);
  });

  test("questionCount: more questions increase score", () => {
    const single = scoreComplexity([msg("what is this?")]);
    const multi = scoreComplexity([msg("what is this? how does it work? why should I care?")]);
    expect(single.dimensions.questionCount).toBeLessThan(multi.dimensions.questionCount);
  });

  test("multiStep: numbered list increases score", () => {
    const plain = scoreComplexity([msg("do the migration")]);
    const numbered = scoreComplexity([msg("do the migration:\n1. Set up the config\n2. Convert files\n3. Run tests\n4. Deploy")]);
    expect(plain.dimensions.multiStep).toBeLessThan(numbered.dimensions.multiStep);
  });

  test("domainBreadth: more technologies increase score", () => {
    const single = scoreComplexity([msg("fix the React component")]);
    const multi = scoreComplexity([msg("connect the React frontend to PostgreSQL via GraphQL, cache with Redis, deploy on Kubernetes")]);
    expect(single.dimensions.domainBreadth).toBeLessThan(multi.dimensions.domainBreadth);
  });

  test("contextDependency: single-message conversation with pronouns scores higher", () => {
    const specific = scoreComplexity([msg("fix the bug in parseJSON")]);
    const vague = scoreComplexity([msg("fix that thing from before")]);
    expect(specific.dimensions.contextDependency).toBeLessThan(vague.dimensions.contextDependency);
  });

  test("instructionCount: more verbs increase score", () => {
    const single = scoreComplexity([msg("add a test")]);
    const multi = scoreComplexity([msg("create a new module, implement the interface, add tests, update the config, deploy to staging")]);
    expect(single.dimensions.instructionCount).toBeLessThan(multi.dimensions.instructionCount);
  });
});

// ─── Custom weights ────────────────────────────────────────────────

describe("custom weights", () => {
  test("zero weight ignores a dimension", () => {
    const normal = scoreComplexity([msg("a".repeat(800))]);
    const noLength = scoreComplexity([msg("a".repeat(800))], {
      weights: { messageLength: 0 },
    });
    // Without length weight, long text should score lower
    expect(noLength.score).toBeLessThan(normal.score);
  });
});

// ─── Last-user-message extraction ──────────────────────────────────

describe("message extraction", () => {
  test("uses last user message", async () => {
    const messages = [
      msg("Design a complex system", "user"),
      msg("Here is my analysis...", "assistant"),
      msg("thanks", "user"),
    ];
    const { tier } = await classify("", messages);
    expect(tier).toBe("LIGHT");
  });

  test("array content format extracts text", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello world" },
          { type: "image" },
        ],
      },
    ];
    const r = scoreComplexity(messages);
    expect(r.textExcerpt).toBe("hello world");
  });
});

// ─── Performance ───────────────────────────────────────────────────

describe("performance", () => {
  test("scores a typical message in under 5ms", () => {
    const text = "write a function to sort an array in ascending order using quicksort";
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      scoreComplexity([msg(text)]);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / 100;
    expect(avgMs).toBeLessThan(5);
    console.log(`  avg=${avgMs.toFixed(2)}ms per call`);
  });
});
