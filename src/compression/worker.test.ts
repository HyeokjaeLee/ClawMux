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

      const apiCall: MakeApiCall = mock(async () => "This is a summary of the conversation.");

      worker.triggerCompression(session, store, apiCall);

      expect(session.compressionState).toBe("computing");
      expect(worker.getStats().activeJobs).toBe(1);

      await new Promise((r) => setTimeout(r, 50));

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

      const apiCall = mock(async () => "summary");

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 50));

      expect(apiCall).toHaveBeenCalledTimes(1);
      const callArgs = (apiCall as ReturnType<typeof mock>).mock.calls[0];
      expect(callArgs[0]).toBe("my-model");
    });

    test("resets to idle on non-timeout error", async () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({ tokenCount: 800 });
      const store = makeStore(session);

      const apiCall: MakeApiCall = mock(async () => {
        throw new Error("API error");
      });

      worker.triggerCompression(session, store, apiCall);
      await new Promise((r) => setTimeout(r, 50));

      expect(session.compressionState).toBe("idle");
      expect(worker.getStats().failedJobs).toBe(1);
      expect(worker.getStats().completedJobs).toBe(0);
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

      resolveFirst("summary1");
      resolveSecond("summary2");
      await new Promise((r) => setTimeout(r, 50));

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
    test("returns combined messages when ready", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        compressionState: "ready",
        compressedMessages: [
          { role: "user", content: "[Summary of previous conversation]\nSummary text" },
          { role: "assistant", content: "Understood." },
        ],
      });

      const result = worker.applyCompression(session);

      expect(result).toBeDefined();
      expect(result!.length).toBe(5);
      expect(result![0].content).toBe("[Summary of previous conversation]\nSummary text");
      expect(result![1].content).toBe("Understood.");
      expect(result![2]).toEqual(session.messages[2]);
      expect(result![3]).toEqual(session.messages[3]);
      expect(result![4]).toEqual(session.messages[4]);
    });

    test("resets session state after applying", () => {
      const worker = createCompressionWorker(makeConfig());
      const session = makeSession({
        compressionState: "ready",
        compressedMessages: [
          { role: "user", content: "summary" },
        ],
        compressedSummary: "summary text",
      });

      worker.applyCompression(session);

      expect(session.compressionState).toBe("idle");
      expect(session.compressedMessages).toBeUndefined();
      expect(session.compressedSummary).toBeUndefined();
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

      const successApi: MakeApiCall = async () => "summary";
      const failApi: MakeApiCall = async () => { throw new Error("fail"); };

      worker.triggerCompression(successSession, store, successApi);
      worker.triggerCompression(failSession, store, failApi);

      await new Promise((r) => setTimeout(r, 100));

      const stats = worker.getStats();
      expect(stats.activeJobs).toBe(0);
      expect(stats.completedJobs).toBe(1);
      expect(stats.failedJobs).toBe(1);
    });

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
});
