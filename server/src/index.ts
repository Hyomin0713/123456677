import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no external dependency)
function loadDotEnv() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      // strip quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // don't override existing env
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.error("[env] failed to load .env:", e);
  }
}

loadDotEnv();

import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";
import { STORE } from "./store.js";
import { PROFILES } from "./profileStore.js";
import {
  createPartySchema,
  joinPartySchema,
  rejoinSchema,
  buffsSchema,
  updateMemberSchema,
  updateTitleSchema,
  kickSchema,
  transferOwnerSchema,
  lockSchema,
  profileSchema
} from "./validators.js";
import { cleanupSessions, cookieSerialize, deleteSession, getSession, newSession, parseCookies, type DiscordUser } from "./auth.js";

const PORT = Number(process.env.PORT ?? 4000);

const ORIGIN_RAW = process.env.ORIGIN!;
const WEB_ORIGIN = process.env.WEB_ORIGIN!;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET!;

const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI!;


function parseOrigins(raw: string): string[] | "*" {
  if (raw === "*") return "*";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ORIGINS = parseOrigins(ORIGIN_RAW);

const app = express();
app.use(
  cors({
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  })
);
app.use(express.json());


// Lightweight in-memory rate limiter (no external deps)
function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || rec.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > opts.max) return res.status(429).json({ error: "RATE_LIMITED" });
    return next();
  };
}


const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  }
});

let broadcastTimer: NodeJS.Timeout | null = null;

function broadcastParties() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    io.emit("partiesUpdated", { parties: STORE.listParties() });
  }, 150);
}
function broadcastParty(partyId: string) {
  const party = STORE.getParty(partyId);
  if (party) io.to(partyId).emit("partyUpdated", { party });
  broadcastParties();
}

function requireAuth(req: express.Request, res: express.Response): { user: DiscordUser } | null {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies["ml_session"];
  const s = getSession(sid);
  if (!s) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
  return { user: s.user };
}

app.get("/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

/** ---------------- Discord OAuth ---------------- */
app.get("/auth/discord", (_req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).send("DISCORD_CLIENT_ID not set");
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify"
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  try {
    const code = String(req.query.code ?? "");
    if (!code) return res.status(400).send("Missing code");

    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!tokenRes.ok) return res.status(500).send("Token exchange failed");

    const tokenJson: any = await tokenRes.json();
    const accessToken = tokenJson.access_token as string;

    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!meRes.ok) return res.status(500).send("Fetch user failed");

    const me: any = await meRes.json();

    const user: DiscordUser = {
      id: String(me.id),
      username: String(me.username),
      global_name: me.global_name ?? null,
      avatar: me.avatar ?? null
    };

    const s = newSession(user);

    res.setHeader(
      "Set-Cookie",
      cookieSerialize("ml_session", s.sessionId, {
        httpOnly: true,
        sameSite: "None",
        secure: true,
        path: "/",
        maxAge: 7 * 24 * 60 * 60
      })
    );

    res.redirect(WEB_ORIGIN);
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});


app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  deleteSession(cookies["ml_session"]);
  res.setHeader("Set-Cookie", cookieSerialize("ml_session", "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 }));
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const s = getSession(cookies["ml_session"]);
  if (!s) return res.status(401).json({ error: "UNAUTHORIZED" });
  const profile = PROFILES.get(s.user.id);
  res.json({ user: s.user, profile });
});

app.get("/api/profile", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  res.json({ profile: PROFILES.get(auth.user.id) });
});

app.put("/api/profile", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  PROFILES.set(auth.user.id, parsed.data);
  res.json({ ok: true, profile: parsed.data });
});

/** ---------------- Party APIs ---------------- */
app.get("/api/parties", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  res.json({ parties: STORE.listParties() });
});

app.post("/api/party/create", rateLimit({ windowMs: 10_000, max: 20 }), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = createPartySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const { party, partyId, memberId } = STORE.createParty(
    { name: parsed.data.name, job: parsed.data.job, power: parsed.data.power },
    parsed.data.title,
    parsed.data.passcode
  );
  broadcastParties();
  res.json({ partyId, memberId, party });
});

app.post("/api/party/join", rateLimit({ windowMs: 10_000, max: 30 }), (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = joinPartySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const result = STORE.joinParty(
    parsed.data.partyId,
    { name: parsed.data.name, job: parsed.data.job, power: parsed.data.power },
    parsed.data.passcode
  );

  if (!result.ok) {
    const status = result.code === "PARTY_NOT_FOUND" ? 404 : 409;
    return res.status(status).json({ error: result.code });
  }

  broadcastParties();
  res.json({ partyId: parsed.data.partyId, memberId: result.memberId, party: result.party });
});

app.post("/api/party/rejoin", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = rejoinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const party = STORE.rejoin(parsed.data.partyId, parsed.data.memberId);
  if (!party) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ party });
});

app.patch("/api/party/:partyId/buffs", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = buffsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const result = STORE.updateBuffs(req.params.partyId, parsed.data.memberId, parsed.data);
  if (!result.ok) return res.status(result.code === "FORBIDDEN" ? 403 : 404).json({ error: result.code });

  io.to(req.params.partyId).emit("partyUpdated", { party: result.party });
  broadcastParties();
  res.json({ party: result.party });
});

app.patch("/api/party/:partyId/members/:memberId", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = updateMemberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const party = STORE.updateMember(req.params.partyId, req.params.memberId, parsed.data);
  if (!party) return res.status(404).json({ error: "NOT_FOUND" });

  io.to(req.params.partyId).emit("partyUpdated", { party });
  broadcastParties();
  res.json({ party });
});

app.patch("/api/party/:partyId/title", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = updateTitleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const result = STORE.updateTitle(req.params.partyId, parsed.data.memberId, parsed.data.title);
  if (!result.ok) return res.status(result.code === "FORBIDDEN" ? 403 : 404).json({ error: result.code });

  io.to(req.params.partyId).emit("partyUpdated", { party: result.party });
  broadcastParties();
  res.json({ party: result.party });
});

app.post("/api/party/:partyId/kick", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = kickSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const result = STORE.kick(req.params.partyId, parsed.data.memberId, parsed.data.targetMemberId);
  if (!result.ok) return res.status(result.code === "FORBIDDEN" ? 403 : 404).json({ error: result.code });

  io.to(req.params.partyId).emit("kicked", { targetMemberId: parsed.data.targetMemberId });
  io.to(req.params.partyId).emit("partyUpdated", { party: result.party });
  broadcastParties();
  res.json({ party: result.party });
});

app.post("/api/party/:partyId/transfer-owner", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = transferOwnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const result = STORE.transferOwner(req.params.partyId, parsed.data.memberId, parsed.data.targetMemberId);
  if (!result.ok) return res.status(result.code === "FORBIDDEN" ? 403 : 404).json({ error: result.code });

  io.to(req.params.partyId).emit("partyUpdated", { party: result.party });
  broadcastParties();
  res.json({ party: result.party });
});

app.patch("/api/party/:partyId/lock", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = lockSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const result = STORE.setLock(req.params.partyId, parsed.data.memberId, parsed.data.enabled, parsed.data.passcode);
  if (!result.ok) return res.status(result.code === "FORBIDDEN" ? 403 : 404).json({ error: result.code });

  io.to(req.params.partyId).emit("partyUpdated", { party: result.party });
  broadcastParties();
  res.json({ party: result.party });
});

/** ---------------- Sockets ---------------- */
io.on("connection", (socket) => {
  socket.on("getParties", () => {
    socket.emit("partiesUpdated", { parties: STORE.listParties() });
  });

  socket.on("joinParty", ({ partyId, memberId }) => {
    const party = STORE.rejoin(partyId, memberId);
    if (!party) {
      socket.emit("errorMessage", { code: "NOT_FOUND" });
      return;
    }
    socket.join(partyId);
    socket.emit("partyUpdated", { party });
    io.to(partyId).emit("partyUpdated", { party });
    broadcastParties();
  });

  socket.on("leaveParty", ({ partyId, memberId }) => {
    socket.leave(partyId);
    const party = STORE.removeMember(partyId, memberId);
    if (party) io.to(partyId).emit("partyUpdated", { party });
    broadcastParties();
  });

  socket.on("ping", ({ partyId, memberId }) => {
    // keep-alive: do not broadcast on every ping (reduces network/CPU)
    STORE.ping(partyId, memberId);
  });
});

setInterval(() => {
  STORE.cleanup();
  cleanupSessions();
  broadcastParties();
}, 60_000);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] ORIGIN=${ORIGIN_RAW}`);
  console.log(`[server] WEB_ORIGIN=${WEB_ORIGIN}`);
  console.log(`[server] DISCORD_REDIRECT_URI=${DISCORD_REDIRECT_URI}`);
});
