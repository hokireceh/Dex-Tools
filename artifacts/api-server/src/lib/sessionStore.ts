import { randomUUID } from "crypto";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari — selaras dengan COOKIE_MAX_AGE di auth.ts
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;      // cleanup tiap 1 jam

export type SessionEntry =
  | { type: "admin" }
  | { type: "user"; userId: number; telegramId: string };

type StoredEntry = SessionEntry & { createdAt: number };

const store = new Map<string, StoredEntry>();

export function createSession(entry: SessionEntry): string {
  const token = randomUUID();
  store.set(token, { ...entry, createdAt: Date.now() });
  return token;
}

export function getSession(token: string): SessionEntry | undefined {
  const entry = store.get(token);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    store.delete(token);
    return undefined;
  }
  const { createdAt: _, ...sessionData } = entry;
  return sessionData as SessionEntry;
}

export function deleteSession(token: string): void {
  store.delete(token);
}

// BUG-SESSION-TTL-001 fix: cleanup periodic setiap 1 jam.
// Mencegah memory leak di server 24/7 — session yang login lama
// tanpa logout tetap tersimpan selamanya tanpa ini.
// Auth security tidak terpengaruh: authMiddleware tetap re-query DB
// setiap request — TTL di sini hanya untuk bounded memory.
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      store.delete(token);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Pastikan interval tidak menghalangi proses Node.js exit
cleanup.unref();
