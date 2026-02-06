const SESSION_KEY = "ml_party_session_v2";
const PROFILE_KEY = "ml_profile_v1";

export type Job = "전사" | "도적" | "궁수" | "마법사";

export type Profile = {
  name: string;
  job: Job;
  power: number; // 스공
};

export type Session = {
  partyId: string;
  memberId: string;
};

export function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.partyId || !data?.memberId) return null;
    return data as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SESSION_KEY);
}

export function loadProfile(): Profile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.name || !data?.job) return null;
    const power = Number(data?.power ?? 0);
    return { name: String(data.name), job: data.job, power: Number.isFinite(power) ? Math.trunc(power) : 0 } as Profile;
  } catch {
    return null;
  }
}

export function saveProfile(p: Profile) {
  if (typeof window === "undefined") return;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
