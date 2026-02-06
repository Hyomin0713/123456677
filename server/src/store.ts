import { nanoid } from "nanoid";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Party, Member, Job, Buffs, PartyLock } from "./types.js";

const MAX_MEMBERS_DEFAULT = 6;

// env로 조절 가능 (ms)
const PARTY_TTL_MS = process.env.PARTY_TTL_MS ? Number(process.env.PARTY_TTL_MS) : 2 * 60 * 60 * 1000; // 기본 2시간 미활동 시 파티 종료
const MEMBER_IDLE_TTL_MS = process.env.MEMBER_IDLE_TTL_MS ? Number(process.env.MEMBER_IDLE_TTL_MS) : 30 * 60 * 1000; // 기본 30분 미활동 시 멤버 제거

function now() {
  return Date.now();
}



function writeFileAtomic(filepath: string, data: string) {
  const dir = path.dirname(filepath);
  const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(tmp, data, "utf-8");
  // Windows에서도 안전하게 교체
  fs.renameSync(tmp, filepath);
}

function clampInt(v: number, max = 9999) {
  if (!Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

function clampPower(v: number) {
  return clampInt(v, 99999);
}

function hashPasscode(partyId: string, passcode: string) {
  return crypto.createHash("sha256").update(`${partyId}:${passcode}`).digest("hex");
}

type Persisted = {
  version: 1;
  savedAt: number;
  parties: Party[];
};

export class PartyStore {
  private parties = new Map<string, Party>();

  private persistFile = process.env.PERSIST_FILE
    ? path.resolve(process.env.PERSIST_FILE)
    : path.resolve(process.cwd(), "data", "parties.json");

  private persistTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.loadFromDisk();
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveToDisk();
    }, 250);
  }

  private saveToDisk() {
    try {
      const dir = path.dirname(this.persistFile);
      fs.mkdirSync(dir, { recursive: true });
      const payload: Persisted = {
        version: 1,
        savedAt: now(),
        parties: Array.from(this.parties.values())
      };
      writeFileAtomic(this.persistFile, JSON.stringify(payload));
    } catch (e) {
      console.error("[store] persist failed:", e);
    }
  }

  private loadFromDisk() {
    try {
      if (!fs.existsSync(this.persistFile)) return;
      const raw = fs.readFileSync(this.persistFile, "utf-8");
      const parsed = JSON.parse(raw) as Persisted;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.parties)) return;

      const t = now();
      for (const p of parsed.parties) {
        // 만료된 파티는 로드하지 않음
        if (!p?.id || !p.expiresAt || p.expiresAt < t) continue;
        // members가 비어있으면 스킵
        if (!p.members || Object.keys(p.members).length === 0) continue;
        // 기본값 방어
        p.maxMembers = p.maxMembers ?? MAX_MEMBERS_DEFAULT;
        p.lock = p.lock ?? ({ enabled: false } as PartyLock);
        this.parties.set(p.id, p);
      }
      console.log(`[store] loaded ${this.parties.size} parties from disk`);
    } catch (e) {
      console.error("[store] load failed:", e);
    }
  }

  listParties() {
    return Array.from(this.parties.values())
      .filter((p) => p.expiresAt >= now())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        id: p.id,
        title: p.title,
        ownerId: p.ownerId,
        maxMembers: p.maxMembers,
        locked: !!p.lock?.enabled,
        membersCount: Object.keys(p.members).length,
        members: Object.values(p.members).map((m) => ({
          id: m.id,
          name: m.name,
          job: m.job,
          power: m.power,
          lastSeenAt: m.lastSeenAt
        })),
        updatedAt: p.updatedAt,
        expiresAt: p.expiresAt
      }));
  }

  createParty(
    profile: { name: string; job: Job; power: number },
    title?: string,
    passcode?: string,
    userId?: string
  ) {
    const partyId = nanoid(8);
    // Prefer stable id (Discord user id) so re-joins don't create duplicate members.
    const memberId = userId?.trim() ? userId.trim() : nanoid(10);
    const t = now();

    const member: Member = {
      id: memberId,
      userId: userId?.trim() ? userId.trim() : undefined,
      name: profile.name.trim().slice(0, 20),
      job: profile.job,
      power: clampPower(profile.power),
      joinedAt: t,
      lastSeenAt: t
    };

    const lock: PartyLock = passcode?.trim()
      ? { enabled: true, passcodeHash: hashPasscode(partyId, passcode.trim()) }
      : { enabled: false };

    const party: Party = {
      id: partyId,
      title: (title?.trim() ? title.trim().slice(0, 30) : "파티").trim(),
      ownerId: memberId,
      maxMembers: MAX_MEMBERS_DEFAULT,
      lock,
      createdAt: t,
      updatedAt: t,
      expiresAt: t + PARTY_TTL_MS,
      buffs: { simbi: 0, bbeongbi: 0, shopbi: 0 },
      members: { [memberId]: member }
    };

    this.parties.set(partyId, party);
    this.schedulePersist();
    return { party, partyId, memberId };
  }

  getParty(partyId: string) {
    const party = this.parties.get(partyId);
    if (!party) return null;
    if (party.expiresAt < now()) {
      this.parties.delete(partyId);
      this.schedulePersist();
      return null;
    }
    return party;
  }

  private memberCount(party: Party) {
    return Object.keys(party.members).length;
  }

  joinParty(
    partyId: string,
    profile: { name: string; job: Job; power: number },
    passcode?: string,
    userId?: string
  ) {
    const party = this.getParty(partyId);
    if (!party) return { ok: false as const, code: "PARTY_NOT_FOUND" as const };

    if (party.lock?.enabled) {
      const given = (passcode ?? "").trim();
      if (!given) return { ok: false as const, code: "PARTY_LOCKED" as const };
      const h = hashPasscode(partyId, given);
      if (h !== party.lock.passcodeHash) return { ok: false as const, code: "INVALID_PASSCODE" as const };
    }

    if (this.memberCount(party) >= party.maxMembers) {
      return { ok: false as const, code: "PARTY_FULL" as const };
    }

    // Prefer a stable id (Discord user id) so rejoining doesn't create duplicates.
    const memberId = (userId ?? "").trim() || nanoid(10);
    const t = now();
    const existing = party.members[memberId];
    if (existing) {
      // Rejoin/update profile
      existing.name = profile.name.trim().slice(0, 20);
      existing.job = profile.job;
      existing.power = clampPower(profile.power);
      existing.lastSeenAt = t;
      existing.userId = userId ?? existing.userId;
    } else {
      party.members[memberId] = {
        id: memberId,
        userId,
        name: profile.name.trim().slice(0, 20),
        job: profile.job,
        power: clampPower(profile.power),
        joinedAt: t,
        lastSeenAt: t
      };
    }
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;

    this.schedulePersist();
    return { ok: true as const, party, memberId };
  }

  rejoin(partyId: string, memberId: string) {
    const party = this.getParty(partyId);
    if (!party) return null;
    const m = party.members[memberId];
    if (!m) return null;
    const t = now();
    m.lastSeenAt = t;
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();
    return party;
  }

  ping(partyId: string, memberId: string) {
    return this.rejoin(partyId, memberId);
  }

  updateBuffs(partyId: string, memberId: string, buffs: Partial<Buffs>) {
    const party = this.getParty(partyId);
    if (!party) return { ok: false as const, code: "PARTY_NOT_FOUND" as const };
    if (party.ownerId !== memberId) return { ok: false as const, code: "FORBIDDEN" as const };

    party.buffs = {
      simbi: clampInt(buffs.simbi ?? party.buffs.simbi),
      bbeongbi: clampInt(buffs.bbeongbi ?? party.buffs.bbeongbi),
      shopbi: clampInt(buffs.shopbi ?? party.buffs.shopbi)
    };
    const t = now();
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();
    return { ok: true as const, party };
  }

  updateMember(partyId: string, memberId: string, patch: { name?: string; job?: Job; power?: number }) {
    const party = this.getParty(partyId);
    if (!party) return null;
    const m = party.members[memberId];
    if (!m) return null;
    if (typeof patch.name === "string" && patch.name.trim()) m.name = patch.name.trim().slice(0, 20);
    if (patch.job) m.job = patch.job;
    if (typeof patch.power === "number") m.power = clampPower(patch.power);
    const t = now();
    m.lastSeenAt = t;
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();
    return party;
  }

  updateTitle(partyId: string, memberId: string, title: string) {
    const party = this.getParty(partyId);
    if (!party) return { ok: false as const, code: "PARTY_NOT_FOUND" as const };
    if (party.ownerId !== memberId) return { ok: false as const, code: "FORBIDDEN" as const };
    const tt = title.trim().slice(0, 30);
    if (!tt) return { ok: false as const, code: "INVALID_TITLE" as const };
    party.title = tt;
    const t = now();
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();
    return { ok: true as const, party };
  }

  setLock(partyId: string, memberId: string, enabled: boolean, passcode?: string) {
    const party = this.getParty(partyId);
    if (!party) return { ok: false as const, code: "PARTY_NOT_FOUND" as const };
    if (party.ownerId !== memberId) return { ok: false as const, code: "FORBIDDEN" as const };

    if (!enabled) {
      party.lock = { enabled: false };
    } else {
      const pc = (passcode ?? "").trim();
      if (!pc) return { ok: false as const, code: "PASSCODE_REQUIRED" as const };
      party.lock = { enabled: true, passcodeHash: hashPasscode(partyId, pc) };
    }
    const t = now();
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();
    return { ok: true as const, party };
  }

  kick(partyId: string, memberId: string, targetMemberId: string) {
    const party = this.getParty(partyId);
    if (!party) return { ok: false as const, code: "PARTY_NOT_FOUND" as const };
    if (party.ownerId !== memberId) return { ok: false as const, code: "FORBIDDEN" as const };
    if (targetMemberId === party.ownerId) return { ok: false as const, code: "CANNOT_KICK_OWNER" as const };
    if (!party.members[targetMemberId]) return { ok: false as const, code: "NOT_FOUND" as const };

    delete party.members[targetMemberId];
    const t = now();
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();

    return { ok: true as const, party };
  }

  transferOwner(partyId: string, memberId: string, targetMemberId: string) {
    const party = this.getParty(partyId);
    if (!party) return { ok: false as const, code: "PARTY_NOT_FOUND" as const };
    if (party.ownerId !== memberId) return { ok: false as const, code: "FORBIDDEN" as const };
    if (!party.members[targetMemberId]) return { ok: false as const, code: "NOT_FOUND" as const };
    party.ownerId = targetMemberId;
    const t = now();
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;
    this.schedulePersist();
    return { ok: true as const, party };
  }

  removeMember(partyId: string, memberId: string) {
    const party = this.getParty(partyId);
    if (!party) return null;
    delete party.members[memberId];

    // 파티장 나가면 첫 멤버로 위임
    if (party.ownerId === memberId) {
      const next = Object.keys(party.members)[0];
      if (next) party.ownerId = next;
    }

    const t = now();
    party.updatedAt = t;
    party.expiresAt = t + PARTY_TTL_MS;

    if (Object.keys(party.members).length === 0) {
      this.parties.delete(partyId);
      this.schedulePersist();
      return null;
    }

    this.schedulePersist();
    return party;
  }

  cleanup() {
    const t = now();
    let changed = false;

    for (const [partyId, party] of this.parties.entries()) {
      // 파티 만료(미활동)
      if (party.expiresAt < t) {
        this.parties.delete(partyId);
        changed = true;
        continue;
      }

      // 멤버 만료
      for (const [memberId, m] of Object.entries(party.members)) {
        if (m.lastSeenAt + MEMBER_IDLE_TTL_MS < t) {
          delete party.members[memberId];
          changed = true;
          if (party.ownerId === memberId) {
            const next = Object.keys(party.members)[0];
            if (next) party.ownerId = next;
          }
        }
      }

      if (Object.keys(party.members).length === 0) {
        this.parties.delete(partyId);
        changed = true;
      }
    }

    if (changed) this.schedulePersist();
  }
}

export const STORE = new PartyStore();
