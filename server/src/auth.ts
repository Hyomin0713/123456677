import crypto from "node:crypto";

export type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

type Session = {
  sessionId: string;
  user: DiscordUser;
  expiresAt: number;
};

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map<string, Session>();

export function newSession(user: DiscordUser) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  const s: Session = { sessionId, user, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(sessionId, s);
  return s;
}

export function getSession(sessionId: string | undefined | null) {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return s;
}

export function deleteSession(sessionId: string | undefined | null) {
  if (!sessionId) return;
  sessions.delete(sessionId);
}

export function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}

export function cookieSerialize(name: string, value: string, opts: { httpOnly?: boolean; maxAge?: number; sameSite?: "Lax"|"Strict"|"None"; path?: string } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  return parts.join("; ");
}

export function parseCookies(header: string | undefined) {
  const out: Record<string,string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}
