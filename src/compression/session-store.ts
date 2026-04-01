import type { Session } from "./types";

export interface SessionStore {
  get(id: string): Session | undefined;
  getOrCreate(id: string, messages: Array<{ role: string; content: unknown }>): Session;
  set(id: string, session: Session): void;
  update(id: string, updates: Partial<Session>): Session | undefined;
  delete(id: string): boolean;
  size(): number;
  has(id: string): boolean;
}

function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function generateSessionId(messages: Array<{ role: string; content: unknown }>): string {
  const firstUserMessage = messages.find((m) => m.role === "user");
  if (!firstUserMessage) return "empty-session";
  const content = typeof firstUserMessage.content === "string"
    ? firstUserMessage.content
    : JSON.stringify(firstUserMessage.content);
  return `session-${djb2Hash(content)}`;
}

export function createSessionStore(maxSessions: number = 500): SessionStore {
  const store = new Map<string, Session>();

  function evictLru(): void {
    if (store.size < maxSessions) return;
    let oldestId = "";
    let oldestAccess = Infinity;
    for (const [id, session] of store) {
      if (session.lastAccess < oldestAccess) {
        oldestAccess = session.lastAccess;
        oldestId = id;
      }
    }
    if (oldestId) store.delete(oldestId);
  }

  return {
    get(id: string): Session | undefined {
      const session = store.get(id);
      if (session) {
        session.lastAccess = Date.now();
      }
      return session;
    },

    getOrCreate(id: string, messages: Array<{ role: string; content: unknown }>): Session {
      const existing = store.get(id);
      if (existing) {
        existing.lastAccess = Date.now();
        return existing;
      }
      evictLru();
      const session: Session = {
        id,
        messages,
        tokenCount: 0,
        compressionState: "idle",
        lastAccess: Date.now(),
      };
      store.set(id, session);
      return session;
    },

    set(id: string, session: Session): void {
      if (!store.has(id)) {
        evictLru();
      }
      if (session.lastAccess === 0) {
        session.lastAccess = Date.now();
      }
      store.set(id, session);
    },

    update(id: string, updates: Partial<Session>): Session | undefined {
      const session = store.get(id);
      if (!session) return undefined;
      Object.assign(session, updates);
      session.lastAccess = Date.now();
      return session;
    },

    delete(id: string): boolean {
      return store.delete(id);
    },

    size(): number {
      return store.size;
    },

    has(id: string): boolean {
      return store.has(id);
    },
  };
}
