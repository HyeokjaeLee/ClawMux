import { describe, test, expect, mock } from "bun:test";
import type { Session } from "./types";
import type { SessionStore } from "./session-store";
import { createSessionStore } from "./session-store";
import {
  createCompressionWorker,
  type MakeApiCall,
  type CompressionWorkerConfig,
} from "./worker";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: "I am fine" },
      { role: "user", content: "Great" },
    ],
    tokenCount: 0,
    compressionState: "idle",
    lastAccess: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CompressionWorkerConfig> = {}): CompressionWorkerConfig {
  return {
    threshold: 0.75,
    targetRatio: 0.6,
    compressionModel: "test-model",
    contextWindow: 1000,
    maxConcurrent: 2,
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeStore(session?: Session): SessionStore {
  const store = createSessionStore();
  if (session) {
    store.set(session.id, session);
  }
  return store;
}

describe("CompressionWorker", () => {
  describe("shouldCompress", () => {
    test("returns false when below threshold", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 700 });
      expect(worker.shouldCompress(session)).toBe(false);
    });

    test("returns true when at threshold", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 750 });
      expect(worker.shouldCompress(session)).toBe(true);
    });

    test("returns true when above threshold", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 900 });
      expect(worker.shouldCompress(session)).toBe(true);
    });

    test("returns false when already computing", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        tokenCount: 900,
        compressionState: "computing",
      });
      expect(worker.shouldCompress(session)).toBe(false);
    });

    test("returns false when already ready", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        tokenCount: 900,
        compressionState: "ready",
      });
      expect(worker.shouldCompress(session)).toBe(false);
    });
  });

  describe("triggerCompression", () => {
    test("transitions session state idle → computing → ready", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      const validSummary = [
        "## Goal\nBuild an app",
        "## Constraints & Preferences\n- None",
        "## Progress\n### Done\n- x",
        "## Key Decisions\n- Decision",
        "## Next Steps\n1. Step",
        "## Critical Context\n- None",
      ].join("\n\n");
      const apiCall: MakeApiCall = mock(async () => validSummary);

      worker.triggerCompression(session, store, apiCall);

      expect(session.compressionState).toBe("computing");
      expect(session.snapshotIndex).toBe(5);
      expect(worker.getStats().activeJobs).toBe(1);

      await new Promise((r) => setTimeout(r, 200));

      expect(session.compressionState).toBe("ready");
      expect(session.compressedMessages).toBeDefined();
      expect(session.compressedMessages!.length).toBe(2);
      expect(worker.getStats().activeJobs).toBe(0);
      expect(worker.getStats().completedJobs).toBe(1);
    });

    test("calls makeApiCall with correct model", async () => {
      const config = makeConfig({ compressionModel: "my-model" });
      const worker = createCompressionWorker(config);
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      const validSummary = [
        "## Goal\nBuild an app",
        "## Constraints & Preferences\n- None",
        "## Progress\n### Done\n- x",
        "## Key Decisions\n- Decision",
        "## Next Steps\n1. Step",
        "## Critical Context\n- None",
      ].join("\n\n");
      const apiCall = mock(async () => validSummary);

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 200));

      const callArgs = (apiCall as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0]).toBe("my-model");
      expect(worker.getStats().completedJobs).toBe(1);
    });

    test("resets to idle after exhausting retries on non-timeout error", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      const apiCall: MakeApiCall = mock(async () => {
        throw new Error("API error");
      });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 5000));

      expect(session.compressionState).toBe("idle");
      expect(worker.getStats().failedJobs).toBe(1);
      expect(worker.getStats().completedJobs).toBe(0);
    }, 10000);

    test("retries on transient error and succeeds", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      let callCount = 0;
      const apiCall: MakeApiCall = mock(async () => {
        callCount++;
        if (callCount < 3) throw new Error("transient error");
        return [
          "## Goal\nBuild an app",
          "## Constraints & Preferences\n- None",
          "## Progress\n### Done\n- x",
          "## Key Decisions\n- Decision",
          "## Next Steps\n1. Step",
          "## Critical Context\n- None",
        ].join("\n\n");
      });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 5000));

      expect(session.compressionState).toBe("ready");
      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(worker.getStats().completedJobs).toBe(1);
    }, 10000);

    test("quality guard triggers re-generation when sections missing", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      let callCount = 0;
      const validSummary = [
        "## Goal\nBuild an app",
        "## Constraints & Preferences\n- None",
        "## Progress\n### Done\n- x",
        "## Key Decisions\n- Decision",
        "## Next Steps\n1. Step",
        "## Critical Context\n- None",
      ].join("\n\n");

      const apiCall: MakeApiCall = mock(async () => {
        callCount++;
        if (callCount === 1) return "## Goal\nOnly goal section";
        return validSummary;
      });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 200));

      expect(session.compressionState).toBe("ready");
      expect(callCount).toBe(2);
      expect(worker.getStats().completedJobs).toBe(1);
    });

    test("uses previousSummary for update prompt on subsequent compression", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        tokenCount: 800,
        compressedSummary: "## Goal\nPrevious summary",
      });
      const store = makeStore(session);

      const capturedMessages: Array<Array<{ role: string; content: string }>> = [];
      const apiCall: MakeApiCall = mock(async (_, messages) => {
        capturedMessages.push(messages);
        return [
          "## Goal\nBuild an app",
          "## Constraints & Preferences\n- None",
          "## Progress\n### Done\n- x",
          "## Key Decisions\n- Decision",
          "## Next Steps\n1. Step",
          "## Critical Context\n- None",
        ].join("\n\n");
      });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 200));

      expect(capturedMessages[0][1].content).toContain("<previous-summary>");
      expect(capturedMessages[0][1].content).toContain("Previous summary");
    });

    test("skips when maxConcurrent reached", async () => {
      const worker = createCompressionWorker(makeConfig({ maxConcurrent: 2 }));

      let resolveFirst!: (v: string) => void;
      let resolveSecond!: (v: string) => void;
      const callCount = { value: 0 };

      const apiCall: MakeApiCall = mock(async () => {
        callCount.value++;
        if (callCount.value === 1) {
          return new Promise<string>((r) => { resolveFirst = r; });
        }
        return new Promise<string>((r) => { resolveSecond = r; });
      });

      const session1 = makeSession({ id: "s1", tokenCount: 800 });
      const session2 = makeSession({ id: "s2", tokenCount: 800 });
      const session3 = makeSession({ id: "s3", tokenCount: 800 });
      const store = createSessionStore();
      store.set("s1", session1);
      store.set("s2", session2);
      store.set("s3", session3);

      worker.triggerCompression(session1, store, apiCall);
      worker.triggerCompression(session2, store, apiCall);
      worker.triggerCompression(session3, store, apiCall);

      expect(worker.getStats().activeJobs).toBe(2);
      expect(session3.compressionState).toBe("idle");

      const validSummary = [
        "## Goal\nBuild an app",
        "## Constraints & Preferences\n- None",
        "## Progress\n### Done\n- x",
        "## Key Decisions\n- Decision",
        "## Next Steps\n1. Step",
        "## Critical Context\n- None",
      ].join("\n\n");
      resolveFirst(validSummary);
      resolveSecond(validSummary);
      await new Promise((r) => setTimeout(r, 200));

      expect(worker.getStats().activeJobs).toBe(0);
      expect(worker.getStats().completedJobs).toBe(2);
    });
  });

  describe("timeout fallback", () => {
    test("falls back to truncation on timeout", async () => {
      const worker = createCompressionWorker(makeConfig({ timeoutMs: 50 }));
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      const apiCall: MakeApiCall = mock(async () => {
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve("too late"), 10_000);
        });
      });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 200));

      expect(session.compressionState).toBe("ready");
      expect(session.compressedMessages).toBeDefined();
      expect(session.compressedMessages!.length).toBeGreaterThan(0);
      expect(worker.getStats().completedJobs).toBe(1);
      expect(worker.getStats().failedJobs).toBe(0);
    });
  });

  describe("applyCompression", () => {
    test("returns summary + post-snapshot messages using snapshotIndex", () => {
      const worker = createCompressionWorker(makeConfig());
      const messages = [
        { role: "user", content: "msg-0" },
        { role: "assistant", content: "msg-1" },
        { role: "user", content: "msg-2 (at snapshot)" },
        { role: "assistant", content: "msg-3 (post-snapshot)" },
        { role: "user", content: "msg-4 (post-snapshot)" },
      ];
      const session = makeSession({
        messages,
        compressionState: "ready",
        snapshotIndex: 3,
        compressedMessages: [
          { role: "user", content: "[Summary of previous conversation]\nSummary text" },
          { role: "assistant", content: "Understood." },
        ],
      });

      const result = worker.applyCompression(session);

      expect(result).toBeDefined();
      expect(result!.length).toBe(4);
      expect(result![0].content).toBe("[Summary of previous conversation]\nSummary text");
      expect(result![1].content).toBe("Understood.");
      expect(result![2]).toEqual(messages[3]);
      expect(result![3]).toEqual(messages[4]);
    });

    test("preserves all messages added after compression trigger", () => {
      const worker = createCompressionWorker(makeConfig());
      const messages = [
        { role: "user", content: "old-1" },
        { role: "assistant", content: "old-2" },
        { role: "user", content: "new-A (post)" },
        { role: "assistant", content: "new-B (post)" },
        { role: "user", content: "new-C (post)" },
        { role: "assistant", content: "new-D (post)" },
        { role: "user", content: "new-E (post)" },
      ];
      const session = makeSession({
        messages,
        compressionState: "ready",
        snapshotIndex: 2,
        compressedMessages: [
          { role: "user", content: "summary" },
        ],
      });

      const result = worker.applyCompression(session);

      expect(result).toBeDefined();
      expect(result!.length).toBe(6);
      expect(result![0].content).toBe("summary");
      expect(result![1].content).toBe("new-A (post)");
      expect(result![5].content).toBe("new-E (post)");
    });

    test("falls back to last 3 when snapshotIndex is undefined", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        compressionState: "ready",
        snapshotIndex: undefined,
        compressedMessages: [
          { role: "user", content: "summary" },
        ],
      });

      const result = worker.applyCompression(session);

      expect(result).toBeDefined();
      expect(result!.length).toBe(4);
      expect(result![0].content).toBe("summary");
      expect(result![1].content).toBe("How are you?");
      expect(result![2].content).toBe("I am fine");
      expect(result![3].content).toBe("Great");
    });

    test("resets session state and snapshotIndex after applying", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        compressionState: "ready",
        compressedMessages: [{ role: "user", content: "summary" }],
        compressedSummary: "summary text",
        snapshotIndex: 2,
      });

      worker.applyCompression(session);

      expect(session.compressionState).toBe("idle");
      expect(session.compressedMessages).toBeUndefined();
      expect(session.compressedSummary).toBeUndefined();
      expect(session.snapshotIndex).toBeUndefined();
    });

    test("returns undefined when not ready", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ compressionState: "idle" });

      expect(worker.applyCompression(session)).toBeUndefined();
    });

    test("returns undefined when computing", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ compressionState: "computing" });

      expect(worker.applyCompression(session)).toBeUndefined();
    });

    test("returns undefined when ready but no compressedMessages", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        compressionState: "ready",
        compressedMessages: undefined,
      });

      expect(worker.applyCompression(session)).toBeUndefined();
    });
  });

  describe("getStats", () => {
    test("tracks completed and failed counts", async () => {
      const worker = createCompressionWorker(makeConfig());
      const store = createSessionStore();

      const successSession = makeSession({ id: "success", tokenCount: 800 });
      const failSession = makeSession({ id: "fail", tokenCount: 800 });
      store.set("success", successSession);
      store.set("fail", failSession);

      const validSummary = [
        "## Goal\nBuild an app",
        "## Constraints & Preferences\n- None",
        "## Progress\n### Done\n- x",
        "## Key Decisions\n- Decision",
        "## Next Steps\n1. Step",
        "## Critical Context\n- None",
      ].join("\n\n");
      const successApi: MakeApiCall = async () => validSummary;
      const failApi: MakeApiCall = async () => { throw new Error("fail"); };

      worker.triggerCompression(successSession, store, successApi);
      worker.triggerCompression(failSession, store, failApi);

      await new Promise((r) => setTimeout(r, 6000));

      const stats = worker.getStats();
      expect(stats.activeJobs).toBe(0);
      expect(stats.completedJobs).toBe(1);
      expect(stats.failedJobs).toBe(1);
    }, 10000);

    test("initial stats are all zero", () => {
      const worker = createCompressionWorker(makeConfig());
      expect(worker.getStats()).toEqual({
        activeJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
      });
    });
  });

  describe("truncation", () => {
    test("keeps last N messages within budget", async () => {
      const worker = createCompressionWorker(
        makeConfig({ timeoutMs: 30, contextWindow: 100, targetRatio: 0.6 }),
      );

      const longMessages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message number ${i} with some content to take up tokens`,
      }));

      const session = makeSession({
        messages: longMessages,
        tokenCount: 80,
      });
      const store = makeStore(session);

      const apiCall: MakeApiCall = async () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("too late"), 10_000);
        });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 200));

      expect(session.compressionState).toBe("ready");
      expect(session.compressedMessages).toBeDefined();
      expect(session.compressedMessages!.length).toBeLessThan(longMessages.length);
      expect(session.compressedMessages!.length).toBeGreaterThan(0);
    });
  });

  describe("terminal error handling", () => {
    test("marks session disabled on 403 Cloudflare (no retry)", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800, id: "403-session" });
      const store = makeStore(session);

      let callCount = 0;
      const makeApiCall: MakeApiCall = mock(async () => {
        callCount++;
        const err = new Error("Compression API call failed: 403 <html>cloudflare</html>") as Error & { status?: number };
        err.status = 403;
        throw err;
      });

      worker.triggerCompression(session, store, makeApiCall);
      await new Promise((r) => setTimeout(r, 200));

      const stored = store.get(session.id);
      expect(stored).toBeDefined();
      expect(stored!.compressionState).toBe("disabled");
      expect(stored!.disabledReason).toContain("403");
      expect(callCount).toBe(1);
    });

    test("marks session disabled on 400 unknown_parameter (no retry)", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800, id: "400-session" });
      const store = makeStore(session);

      let callCount = 0;
      const makeApiCall: MakeApiCall = mock(async () => {
        callCount++;
        throw new Error("Compression API call failed: 400 {\"error\":\"Unknown parameter: 'input[176].reasoning_content'\"}");
      });

      worker.triggerCompression(session, store, makeApiCall);
      await new Promise((r) => setTimeout(r, 200));

      const stored = store.get(session.id);
      expect(stored!.compressionState).toBe("disabled");
      expect(callCount).toBe(1);
    });

    test("retries on transient 500 errors", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800, id: "500-session" });
      const store = makeStore(session);

      let callCount = 0;
      const makeApiCall: MakeApiCall = mock(async () => {
        callCount++;
        throw new Error("Upstream 500 transient");
      });

      worker.triggerCompression(session, store, makeApiCall);
      await new Promise((r) => setTimeout(r, 8000));

      expect(callCount).toBeGreaterThan(1);
      const stored = store.get(session.id);
      expect(stored!.compressionState).toBe("idle");
    }, 15000);

    test("shouldCompress returns false for disabled sessions", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        tokenCount: 900,
        compressionState: "disabled",
      });
      expect(worker.shouldCompress(session)).toBe(false);
    });

    test("does not false-positive terminal when 500 body embeds '400' text", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800, id: "false-pos-session" });
      const store = makeStore(session);

      let callCount = 0;
      const makeApiCall: MakeApiCall = mock(async () => {
        callCount++;
        throw new Error('Upstream 500: previous attempt returned "400 Bad Request"');
      });

      worker.triggerCompression(session, store, makeApiCall);
      await new Promise((r) => setTimeout(r, 8000));

      expect(callCount).toBeGreaterThan(1);
      const stored = store.get(session.id);
      expect(stored!.compressionState).not.toBe("disabled");
    }, 15000);

    test("prefers err.status over message regex", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800, id: "status-priority" });
      const store = makeStore(session);

      const makeApiCall: MakeApiCall = mock(async () => {
        const err = new Error("Compression API call failed: 500 transient") as Error & { status?: number };
        err.status = 500;
        throw err;
      });

      worker.triggerCompression(session, store, makeApiCall);
      await new Promise((r) => setTimeout(r, 8000));

      const stored = store.get(session.id);
      expect(stored!.compressionState).not.toBe("disabled");
    }, 15000);
  });
});
