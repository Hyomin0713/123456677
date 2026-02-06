import crypto from "node:crypto";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map();
export function newSession(user) {
    const sessionId = crypto.randomBytes(24).toString("hex");
    const s = { sessionId, user, expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(sessionId, s);
    return s;
}
export function getSession(sessionId) {
    if (!sessionId)
        return null;
    const s = sessions.get(sessionId);
    if (!s)
        return null;
    if (s.expiresAt < Date.now()) {
        sessions.delete(sessionId);
        return null;
    }
    return s;
}
export function deleteSession(sessionId) {
    if (!sessionId)
        return;
    sessions.delete(sessionId);
}
export function cleanupSessions() {
    const now = Date.now();
    for (const [id, s] of sessions.entries()) {
        if (s.expiresAt < now)
            sessions.delete(id);
    }
}
export function cookieSerialize(name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${opts.path ?? "/"}`);
    if (opts.maxAge)
        parts.push(`Max-Age=${opts.maxAge}`);
    parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
    if (opts.httpOnly !== false)
        parts.push("HttpOnly");
    return parts.join("; ");
}
export function parseCookies(header) {
    const out = {};
    if (!header)
        return out;
    for (const part of header.split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (!k)
            continue;
        out[k] = decodeURIComponent(rest.join("=") || "");
    }
    return out;
}
