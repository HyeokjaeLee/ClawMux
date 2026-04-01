import { describe, expect, it } from "bun:test";
import { createSessionStore, generateSessionId } from "./session-store";
import type { Session } from "./types";

const makeMessages = (content: string): Array<{ role: string; content: unknown }> => [
  { role: "user", content },
];

const makeSession = (id: string, messages: Array<{ role: string; content: unknown }>, lastAccess: number): Session => ({
  id,
  messages,
  tokenCount: 0,
  compressionState: "idle",
  lastAccess,
});

describe("SessionStore", () => {
  it("creates store with default maxSessions", () => {
    const store = createSessionStore();
    expect(store.size()).toBe(0);
  });

  it("adds 3 sessions and size is 3", () => {
    const store = createSessionStore(3);
    store.set("s1", makeSession("s1", makeMessages("a"), 100));
    store.set("s2", makeSession("s2", makeMessages("b"), 200));
    store.set("s3", makeSession("s3", makeMessages("c"), 300));
    expect(store.size()).toBe(3);
  });

  it("evicts oldest when adding 4th session (maxSessions=3)", () => {
    const store = createSessionStore(3);
    store.set("s1", makeSession("s1", makeMessages("a"), 100));
    store.set("s2", makeSession("s2", makeMessages("b"), 200));
    store.set("s3", makeSession("s3", makeMessages("c"), 300));
    store.set("s4", makeSession("s4", makeMessages("d"), 400));
    expect(store.size()).toBe(3);
    expect(store.has("s1")).toBe(false); // oldest evicted
    expect(store.has("s4")).toBe(true);
  });

  it("get() updates lastAccess preventing eviction", () => {
    const store = createSessionStore(3);
    store.set("s1", makeSession("s1", makeMessages("a"), 100));
    store.set("s2", makeSession("s2", makeMessages("b"), 200));
    store.set("s3", makeSession("s3", makeMessages("c"), 300));

    // access s1 to bump its lastAccess
    store.get("s1");

    // add new session — s2 should be evicted (oldest untouched)
    store.set("s4", makeSession("s4", makeMessages("d"), 400));
    expect(store.has("s1")).toBe(true); // accessed recently
    expect(store.has("s2")).toBe(false); // oldest untouched → evicted
    expect(store.size()).toBe(3);
  });

  it("getOrCreate() creates new session", () => {
    const store = createSessionStore(10);
    const session = store.getOrCreate("new-id", makeMessages("hello"));
    expect(session.id).toBe("new-id");
    expect(session.messages).toEqual(makeMessages("hello"));
    expect(session.compressionState).toBe("idle");
    expect(store.size()).toBe(1);
  });

  it("getOrCreate() returns existing session for same id", () => {
    const store = createSessionStore(10);
    const msgs = makeMessages("hello");
    const first = store.getOrCreate("id1", msgs);
    first.compressionState = "ready";
    const second = store.getOrCreate("id1", msgs);
    expect(second).toBe(first);
    expect(second.compressionState).toBe("ready");
    expect(store.size()).toBe(1);
  });

  it("getOrCreate() with same first user message via generateSessionId returns existing", () => {
    const store = createSessionStore(10);
    const msgs = makeMessages("same content");
    const id = generateSessionId(msgs);
    const first = store.getOrCreate(id, msgs);
    const second = store.getOrCreate(id, msgs);
    expect(first).toBe(second);
    expect(store.size()).toBe(1);
  });

  it("update() changes session fields", () => {
    const store = createSessionStore(10);
    const msgs = makeMessages("test");
    const session = store.getOrCreate("u1", msgs);
    const updated = store.update("u1", {
      compressionState: "computing",
      tokenCount: 42,
    });
    expect(updated).toBeDefined();
    expect(updated!.compressionState).toBe("computing");
    expect(updated!.tokenCount).toBe(42);
    expect(updated!.messages).toEqual(msgs);
  });

  it("update() returns undefined for non-existent session", () => {
    const store = createSessionStore(10);
    const result = store.update("nonexistent", { tokenCount: 1 });
    expect(result).toBeUndefined();
  });

  it("delete() removes session", () => {
    const store = createSessionStore(10);
    store.getOrCreate("d1", makeMessages("x"));
    expect(store.size()).toBe(1);
    expect(store.delete("d1")).toBe(true);
    expect(store.size()).toBe(0);
    expect(store.has("d1")).toBe(false);
  });

  it("delete() returns false for non-existent session", () => {
    const store = createSessionStore(10);
    expect(store.delete("nope")).toBe(false);
  });

  it("has() returns correct boolean", () => {
    const store = createSessionStore(10);
    store.getOrCreate("h1", makeMessages("x"));
    expect(store.has("h1")).toBe(true);
    expect(store.has("h2")).toBe(false);
  });

  it("get() returns undefined for non-existent session", () => {
    const store = createSessionStore(10);
    expect(store.get("nope")).toBeUndefined();
  });

  it("set() upserts existing session", () => {
    const store = createSessionStore(10);
    store.set("u1", makeSession("u1", makeMessages("old"), 100));
    store.set("u1", makeSession("u1", makeMessages("new"), 200));
    expect(store.size()).toBe(1);
    expect(store.get("u1")!.messages).toEqual(makeMessages("new"));
  });
});

describe("generateSessionId", () => {
  it("same messages produce same ID", () => {
    const msgs1 = [{ role: "user", content: "hello world" }];
    const msgs2 = [{ role: "user", content: "hello world" }];
    expect(generateSessionId(msgs1)).toBe(generateSessionId(msgs2));
  });

  it("different messages produce different IDs", () => {
    const msgs1 = [{ role: "user", content: "hello" }];
    const msgs2 = [{ role: "user", content: "goodbye" }];
    expect(generateSessionId(msgs1)).not.toBe(generateSessionId(msgs2));
  });

  it("no user message returns empty-session", () => {
    const msgs = [{ role: "assistant", content: "hi" }];
    expect(generateSessionId(msgs)).toBe("empty-session");
  });

  it("empty messages returns empty-session", () => {
    expect(generateSessionId([])).toBe("empty-session");
  });

  it("hashes first user message content", () => {
    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "actual user message" },
      { role: "user", content: "second user message" },
    ];
    const id = generateSessionId(msgs);
    // Should be based on first user message, not second
    const firstOnly = [{ role: "user", content: "actual user message" }];
    expect(id).toBe(generateSessionId(firstOnly));
  });
});
