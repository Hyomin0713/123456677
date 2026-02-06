import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const MAX_MEMBERS_DEFAULT = 6;
// env로 조절 가능 (ms)
const PARTY_TTL_MS = process.env.PARTY_TTL_MS ? Number(process.env.PARTY_TTL_MS) : 2 * 60 * 60 * 1000; // 기본 2시간 미활동 시 파티 종료
const MEMBER_IDLE_TTL_MS = process.env.MEMBER_IDLE_TTL_MS ? Number(process.env.MEMBER_IDLE_TTL_MS) : 30 * 60 * 1000; // 기본 30분 미활동 시 멤버 제거
function now() {
    return Date.now();
}
function writeFileAtomic(filepath, data) {
    const dir = path.dirname(filepath);
    const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(tmp, data, "utf-8");
    // Windows에서도 안전하게 교체
    fs.renameSync(tmp, filepath);
}
function clampInt(v, max = 9999) {
    if (!Number.isFinite(v))
        return 0;
    const n = Math.trunc(v);
    if (n < 0)
        return 0;
    if (n > max)
        return max;
    return n;
}
function clampPower(v) {
    return clampInt(v, 99999);
}
function hashPasscode(partyId, passcode) {
    return crypto.createHash("sha256").update(`${partyId}:${passcode}`).digest("hex");
}
export class PartyStore {
    parties = new Map();
    persistFile = process.env.PERSIST_FILE
        ? path.resolve(process.env.PERSIST_FILE)
        : path.resolve(process.cwd(), "data", "parties.json");
    persistTimer = null;
    constructor() {
        this.loadFromDisk();
    }
    schedulePersist() {
        if (this.persistTimer)
            return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.saveToDisk();
        }, 250);
    }
    saveToDisk() {
        try {
            const dir = path.dirname(this.persistFile);
            fs.mkdirSync(dir, { recursive: true });
            const payload = {
                version: 1,
                savedAt: now(),
                parties: Array.from(this.parties.values())
            };
            writeFileAtomic(this.persistFile, JSON.stringify(payload));
        }
        catch (e) {
            console.error("[store] persist failed:", e);
        }
    }
    loadFromDisk() {
        try {
            if (!fs.existsSync(this.persistFile))
                return;
            const raw = fs.readFileSync(this.persistFile, "utf-8");
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.parties))
                return;
            const t = now();
            for (const p of parsed.parties) {
                // 만료된 파티는 로드하지 않음
                if (!p?.id || !p.expiresAt || p.expiresAt < t)
                    continue;
                // members가 비어있으면 스킵
                if (!p.members || Object.keys(p.members).length === 0)
                    continue;
                // 기본값 방어
                p.maxMembers = p.maxMembers ?? MAX_MEMBERS_DEFAULT;
                p.lock = p.lock ?? { enabled: false };
                this.parties.set(p.id, p);
            }
            console.log(`[store] loaded ${this.parties.size} parties from disk`);
        }
        catch (e) {
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
    createParty(profile, title, passcode) {
        const partyId = nanoid(8);
        const memberId = nanoid(10);
        const t = now();
        const member = {
            id: memberId,
            name: profile.name.trim().slice(0, 20),
            job: profile.job,
            power: clampPower(profile.power),
            joinedAt: t,
            lastSeenAt: t
        };
        const lock = passcode?.trim()
            ? { enabled: true, passcodeHash: hashPasscode(partyId, passcode.trim()) }
            : { enabled: false };
        const party = {
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
    getParty(partyId) {
        const party = this.parties.get(partyId);
        if (!party)
            return null;
        if (party.expiresAt < now()) {
            this.parties.delete(partyId);
            this.schedulePersist();
            return null;
        }
        return party;
    }
    /** 파티를 강제로 삭제 (정리/관리용) */
    deleteParty(partyId) {
        const existed = this.parties.delete(partyId);
        if (existed)
            this.schedulePersist();
        return existed;
    }
    memberCount(party) {
        return Object.keys(party.members).length;
    }
    joinParty(partyId, profile, passcode) {
        const party = this.getParty(partyId);
        if (!party)
            return { ok: false, code: "PARTY_NOT_FOUND" };
        if (party.lock?.enabled) {
            const given = (passcode ?? "").trim();
            if (!given)
                return { ok: false, code: "PARTY_LOCKED" };
            const h = hashPasscode(partyId, given);
            if (h !== party.lock.passcodeHash)
                return { ok: false, code: "INVALID_PASSCODE" };
        }
        if (this.memberCount(party) >= party.maxMembers) {
            return { ok: false, code: "PARTY_FULL" };
        }
        const memberId = nanoid(10);
        const t = now();
        party.members[memberId] = {
            id: memberId,
            name: profile.name.trim().slice(0, 20),
            job: profile.job,
            power: clampPower(profile.power),
            joinedAt: t,
            lastSeenAt: t
        };
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return { ok: true, party, memberId };
    }
    rejoin(partyId, memberId) {
        const party = this.getParty(partyId);
        if (!party)
            return null;
        const m = party.members[memberId];
        if (!m)
            return null;
        const t = now();
        m.lastSeenAt = t;
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return party;
    }
    ping(partyId, memberId) {
        return this.rejoin(partyId, memberId);
    }
    updateBuffs(partyId, memberId, buffs) {
        const party = this.getParty(partyId);
        if (!party)
            return { ok: false, code: "PARTY_NOT_FOUND" };
        if (party.ownerId !== memberId)
            return { ok: false, code: "FORBIDDEN" };
        party.buffs = {
            simbi: clampInt(buffs.simbi ?? party.buffs.simbi),
            bbeongbi: clampInt(buffs.bbeongbi ?? party.buffs.bbeongbi),
            shopbi: clampInt(buffs.shopbi ?? party.buffs.shopbi)
        };
        const t = now();
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return { ok: true, party };
    }
    updateMember(partyId, memberId, patch) {
        const party = this.getParty(partyId);
        if (!party)
            return null;
        const m = party.members[memberId];
        if (!m)
            return null;
        if (typeof patch.name === "string" && patch.name.trim())
            m.name = patch.name.trim().slice(0, 20);
        if (patch.job)
            m.job = patch.job;
        if (typeof patch.power === "number")
            m.power = clampPower(patch.power);
        const t = now();
        m.lastSeenAt = t;
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return party;
    }
    updateTitle(partyId, memberId, title) {
        const party = this.getParty(partyId);
        if (!party)
            return { ok: false, code: "PARTY_NOT_FOUND" };
        if (party.ownerId !== memberId)
            return { ok: false, code: "FORBIDDEN" };
        const tt = title.trim().slice(0, 30);
        if (!tt)
            return { ok: false, code: "INVALID_TITLE" };
        party.title = tt;
        const t = now();
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return { ok: true, party };
    }
    setLock(partyId, memberId, enabled, passcode) {
        const party = this.getParty(partyId);
        if (!party)
            return { ok: false, code: "PARTY_NOT_FOUND" };
        if (party.ownerId !== memberId)
            return { ok: false, code: "FORBIDDEN" };
        if (!enabled) {
            party.lock = { enabled: false };
        }
        else {
            const pc = (passcode ?? "").trim();
            if (!pc)
                return { ok: false, code: "PASSCODE_REQUIRED" };
            party.lock = { enabled: true, passcodeHash: hashPasscode(partyId, pc) };
        }
        const t = now();
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return { ok: true, party };
    }
    kick(partyId, memberId, targetMemberId) {
        const party = this.getParty(partyId);
        if (!party)
            return { ok: false, code: "PARTY_NOT_FOUND" };
        if (party.ownerId !== memberId)
            return { ok: false, code: "FORBIDDEN" };
        if (targetMemberId === party.ownerId)
            return { ok: false, code: "CANNOT_KICK_OWNER" };
        if (!party.members[targetMemberId])
            return { ok: false, code: "NOT_FOUND" };
        delete party.members[targetMemberId];
        const t = now();
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return { ok: true, party };
    }
    transferOwner(partyId, memberId, targetMemberId) {
        const party = this.getParty(partyId);
        if (!party)
            return { ok: false, code: "PARTY_NOT_FOUND" };
        if (party.ownerId !== memberId)
            return { ok: false, code: "FORBIDDEN" };
        if (!party.members[targetMemberId])
            return { ok: false, code: "NOT_FOUND" };
        party.ownerId = targetMemberId;
        const t = now();
        party.updatedAt = t;
        party.expiresAt = t + PARTY_TTL_MS;
        this.schedulePersist();
        return { ok: true, party };
    }
    removeMember(partyId, memberId) {
        const party = this.getParty(partyId);
        if (!party)
            return null;
        delete party.members[memberId];
        // 파티장 나가면 첫 멤버로 위임
        if (party.ownerId === memberId) {
            const next = Object.keys(party.members)[0];
            if (next)
                party.ownerId = next;
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
                        if (next)
                            party.ownerId = next;
                    }
                }
            }
            if (Object.keys(party.members).length === 0) {
                this.parties.delete(partyId);
                changed = true;
            }
        }
        if (changed)
            this.schedulePersist();
    }
}
export const STORE = new PartyStore();
