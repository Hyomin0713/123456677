export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:4000";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data?.error ? `${data.error}` : msg;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function health() {
  const res = await fetch(`${API_BASE}/health`, { cache: "no-store", credentials: "include" });
  return j<any>(res);
}

export async function getMe() {
  const res = await fetch(`${API_BASE}/api/me`, { cache: "no-store", credentials: "include" });
  return j<{ user: any; profile: any | null }>(res);
}

export async function logout() {
  const res = await fetch(`${API_BASE}/api/logout`, { method: "POST", cache: "no-store", credentials: "include" });
  return j<any>(res);
}

export async function getProfile() {
  const res = await fetch(`${API_BASE}/api/profile`, { cache: "no-store", credentials: "include" });
  return j<{ profile: any | null }>(res);
}

export async function saveProfile(input: { name: string; job: string; power: number }) {
  const res = await fetch(`${API_BASE}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(input)
  });
  return j<{ ok: true; profile: any }>(res);
}

export async function listParties() {
  const res = await fetch(`${API_BASE}/api/parties`, { cache: "no-store", credentials: "include" });
  return j<{ parties: any[] }>(res);
}

export async function createParty(input: { title?: string; passcode?: string; name: string; job: string; power: number }) {
  const res = await fetch(`${API_BASE}/api/party/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(input)
  });
  return j<{ partyId: string; memberId: string; party: any }>(res);
}

export async function joinParty(input: { partyId: string; passcode?: string; name: string; job: string; power: number }) {
  const res = await fetch(`${API_BASE}/api/party/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(input)
  });
  return j<{ partyId: string; memberId: string; party: any }>(res);
}

export async function rejoinParty(input: { partyId: string; memberId: string }) {
  const res = await fetch(`${API_BASE}/api/party/rejoin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(input)
  });
  return j<{ party: any }>(res);
}

export async function updateBuffs(
  partyId: string,
  memberId: string,
  buffs: Partial<{ simbi: number; bbeongbi: number; shopbi: number }>
) {
  const res = await fetch(`${API_BASE}/api/party/${partyId}/buffs`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ memberId, ...buffs })
  });
  return j<{ party: any }>(res);
}

export async function updateTitle(partyId: string, memberId: string, title: string) {
  const res = await fetch(`${API_BASE}/api/party/${partyId}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ memberId, title })
  });
  return j<{ party: any }>(res);
}

export async function kickMember(partyId: string, memberId: string, targetMemberId: string) {
  const res = await fetch(`${API_BASE}/api/party/${partyId}/kick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ memberId, targetMemberId })
  });
  return j<{ party: any }>(res);
}

export async function transferOwner(partyId: string, memberId: string, targetMemberId: string) {
  const res = await fetch(`${API_BASE}/api/party/${partyId}/transfer-owner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ memberId, targetMemberId })
  });
  return j<{ party: any }>(res);
}

export async function setLock(partyId: string, memberId: string, enabled: boolean, passcode?: string) {
  const res = await fetch(`${API_BASE}/api/party/${partyId}/lock`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ memberId, enabled, passcode })
  });
  return j<{ party: any }>(res);
}

export async function updateMyProfileInParty(partyId: string, memberId: string, patch: { name?: string; job?: string; power?: number }) {
  const res = await fetch(`${API_BASE}/api/party/${partyId}/members/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(patch)
  });
  return j<{ party: any }>(res);
}
