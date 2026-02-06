"use client";

import {useEffect, useMemo, useRef, useState, useCallback} from "react";
import {
  API_BASE,
  createParty,
  joinParty,
  listParties,
  rejoinParty,
  updateBuffs,
  updateTitle as apiUpdateTitle,
  kickMember as apiKickMember,
  transferOwner as apiTransferOwner,
  setLock as apiSetLock,
  updateMyProfileInParty,
  health as apiHealth,
  getMe,
  saveProfile as apiSaveProfile,
  logout as apiLogout
} from "@/lib/api";
import { clearSession, loadProfile, loadSession, saveProfile, saveSession, type Profile, type Session } from "@/lib/storage";
import { getSocket } from "@/lib/socket";

type ToastItem = { id: string; text: string; kind?: "info" | "error" | "success" };

type Party = {
  id: string;
  title: string;
  ownerId: string;
  maxMembers: number;
  lock?: { enabled: boolean };
  buffs: { simbi: number; bbeongbi: number; shopbi: number };
  members: Record<string, { id: string; name: string; job: string; power: number; lastSeenAt: number }>;
  expiresAt: number;
  updatedAt: number;
};

type PartySummary = {
  id: string;
  title: string;
  ownerId: string;
  maxMembers: number;
  locked: boolean;
  membersCount: number;
  members: Array<{ id: string; name: string; job: string; power: number; lastSeenAt: number }>;
  updatedAt: number;
  expiresAt: number;
};

const JOBS = ["전사", "도적", "궁수", "마법사"] as const;

export default function Page() {
  const [mode, setMode] = useState<"idle" | "inParty">("idle");
  const [toast, setToast] = useState<string>("");
  const [toastItems, setToastItems] = useState<ToastItem[]>([]);
  const [party, setParty] = useState<Party | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile>({ name: "", job: "전사", power: 0 });
  const [user, setUser] = useState<any | null>(null);
  const [authReady, setAuthReady] = useState(false);

    const [health, setHealth] = useState<"unknown" | "ok" | "fail">("unknown");
  const [parties, setParties] = useState<PartySummary[]>([]);

  // create/join form
  const [partyIdInput, setPartyIdInput] = useState("");
  const [titleInput, setTitleInput] = useState("파티");
  const [createPasscode, setCreatePasscode] = useState(""); // 잠금 비밀번호

  // join flow (locked party)
  const [joinPasscode, setJoinPasscode] = useState("");

  // party controls
  const [titleEdit, setTitleEdit] = useState("");
  const [lockEnabled, setLockEnabled] = useState(false);
  const [lockPasscode, setLockPasscode] = useState("");

  // buffs input
  const [simbi, setSimbi] = useState("0");
  const [bbeongbi, setBbeongbi] = useState("0");
  const [shopbi, setShopbi] = useState("0");

  // party list detail modal
  const [detail, setDetail] = useState<PartySummary | null>(null);

  const socket = useMemo(() => getSocket(), []);
  const pingTimer = useRef<any>(null);

  const isOwner = useMemo(() => {
    if (!party || !session) return false;
    return party.ownerId === session.memberId;
  }, [party, session]);

  useEffect(() => {
    const p = loadProfile();
    if (p) setProfile(p);

    // query param ?partyId=xxxx (초대 링크)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const pid = url.searchParams.get("partyId");
      if (pid) setPartyIdInput(pid);
    }

    pingHealth();

    // 디스코드 로그인 상태 확인 + 프로필 불러오기
    getMe()
      .then(({ user, profile }) => {
        setUser(user);
        if (profile) {
          setProfile(profile);
        } else {
          // 최초 1회 기본값(디스코드 닉네임)
          const name = String(user?.global_name || user?.username || "").trim();
          if (name) setProfile((p) => ({ ...p, name }));
        }
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => setAuthReady(true));

    refreshParties();
    socket.emit("getParties");

    // 세션 자동 재입장
    const s = loadSession();
    if (!s) return;

    setSession(s);
    setMode("inParty");

    rejoinParty({ partyId: s.partyId, memberId: s.memberId })
      .then(({ party }) => {
        setParty(party);
        setTitleEdit(party.title ?? "");
        setLockEnabled(!!party.lock?.enabled);
        setBuffInputs(party);
        socket.emit("joinParty", { partyId: s.partyId, memberId: s.memberId });
        setDetail(null);
        setToast("");
      })
      .catch(() => {
        clearSession();
        setSession(null);
        setMode("idle");
        setParty(null);
        setToast("자동 재입장 실패: 방이 만료되었거나 멤버가 삭제되었어요.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    socket.on("partyUpdated", ({ party }: any) => {
      setParty(party);
      setTitleEdit(party?.title ?? "");
      setLockEnabled(!!party?.lock?.enabled);
      setBuffInputs(party);
    });
    socket.on("partiesUpdated", ({ parties }: any) => {
      setParties(parties ?? []);
      if (detail) {
        const updated = (parties ?? []).find((x: PartySummary) => x.id === detail.id);
        if (updated) setDetail(updated);
      }
    });
    socket.on("kicked", ({ targetMemberId }: any) => {
      if (session?.memberId && targetMemberId === session.memberId) {
        setToast("추방되었습니다.");
        onLeave(true);
      }
    });
    socket.on("errorMessage", ({ code }: any) => setToast(prettyErrorCode(String(code))));
    return () => {
      socket.off("partyUpdated");
      socket.off("partiesUpdated");
      socket.off("kicked");
      socket.off("errorMessage");
    };
  }, [socket, session, detail]);

  useEffect(() => {
    if (mode !== "inParty" || !session) return;
    clearInterval(pingTimer.current);
    pingTimer.current = setInterval(() => {
      socket.emit("ping", { partyId: session.partyId, memberId: session.memberId });
    }, 25_000);
    return () => clearInterval(pingTimer.current);
  }, [mode, session, socket]);

  function setBuffInputs(p: Party) {
    setSimbi(String(p.buffs?.simbi ?? 0));
    setBbeongbi(String(p.buffs?.bbeongbi ?? 0));
    setShopbi(String(p.buffs?.shopbi ?? 0));
  }

  async function pingHealth() {
    try {
      await apiHealth();
      setHealth("ok");
    } catch {
      setHealth("fail");
    }
  }

  const loginUrl = `${API_BASE}/auth/discord`;

  async function onLogout() {
    try {
      await apiLogout();
    } catch {}
    setUser(null);
    setAuthReady(true);
    pushToast("로그아웃됨", "info");
  }

  async function refreshParties() {
    try {
      const res = await listParties();
      setParties(res.parties as any);
    } catch {}
  }

  async function onSaveProfile() {
    try {
    const p: Profile = {
      name: profile.name.trim().slice(0, 20),
      job: profile.job,
      power: clampPower(profile.power)
    };
    setProfile(p);
    await apiSaveProfile(p as any);
    pushToast("프로필 저장됨", "success");
    } catch (e:any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function onCreate() {
    try {
      setToast("");
      const p = safeProfile(profile);
      const passcode = createPasscode.trim() || undefined;
      const res = await createParty({ title: titleInput.trim() || "파티", passcode, name: p.name, job: p.job, power: p.power });
      const s: Session = { partyId: res.partyId, memberId: res.memberId };
      saveSession(s);
      setSession(s);
      setParty(res.party);
      setTitleEdit(res.party?.title ?? "");
      setLockEnabled(!!res.party?.lock?.enabled);
      setBuffInputs(res.party);
      setMode("inParty");
      socket.emit("joinParty", { partyId: res.partyId, memberId: res.memberId });
      setDetail(null);
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
      setHealth("fail");
    }
  }

  async function onJoin(partyId?: string, passcode?: string) {
    try {
      setToast("");
      const pid = (partyId ?? partyIdInput).trim();
      const p = safeProfile(profile);
      const res = await joinParty({ partyId: pid, passcode: passcode?.trim() || undefined, name: p.name, job: p.job, power: p.power });
      const s: Session = { partyId: pid, memberId: res.memberId };
      saveSession(s);
      setSession(s);
      setParty(res.party);
      setTitleEdit(res.party?.title ?? "");
      setLockEnabled(!!res.party?.lock?.enabled);
      setBuffInputs(res.party);
      setMode("inParty");
      socket.emit("joinParty", { partyId: pid, memberId: res.memberId });
      setJoinPasscode("");
      setDetail(null);

    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
      setHealth("fail");
    }
  }

  async function onUpdateBuffs() {
    if (!party || !session) return;
    try {
      setToast("");
      const payload = {
        simbi: clampBuff(simbi),
        bbeongbi: clampBuff(bbeongbi),
        shopbi: clampBuff(shopbi)
      };
      await updateBuffs(party.id, session.memberId, payload);
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function onRename() {
    if (!party || !session) return;
    try {
      setToast("");
      const title = titleEdit.trim().slice(0, 30);
      await apiUpdateTitle(party.id, session.memberId, title);
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function onKick(targetMemberId: string) {
    if (!party || !session) return;
    try {
      setToast("");
      await apiKickMember(party.id, session.memberId, targetMemberId);
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function onTransferOwner(targetMemberId: string) {
    if (!party || !session) return;
    try {
      setToast("");
      await apiTransferOwner(party.id, session.memberId, targetMemberId);
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function onApplyLock() {
    if (!party || !session) return;
    try {
      setToast("");
      if (lockEnabled) {
        const pc = lockPasscode.trim();
        await apiSetLock(party.id, session.memberId, true, pc);
        setLockPasscode("");
      } else {
        await apiSetLock(party.id, session.memberId, false);
        setLockPasscode("");
      }
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function onUpdateMyProfileInParty() {
    if (!party || !session) return;
    try {
      setToast("");
      const p = safeProfile(profile);
      await apiSaveProfile(p as any);
      await updateMyProfileInParty(party.id, session.memberId, { name: p.name, job: p.job, power: p.power });
      setToast("내 정보 반영됨");
    } catch (e: any) {
      pushToast(prettyFetchError(e?.message), "error"); setToast("");
    }
  }

  async function copyPartyId() {
    if (!party) return;
    await safeCopy(party.id);
    setToast("Party ID 복사됨");
  }

  async function copyInviteLink() {
    if (!party) return;
    const url = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}?partyId=${party.id}` : party.id;
    await safeCopy(url);
    setToast("초대 링크 복사됨");
  }

  function openDetail(p: PartySummary) {
    setDetail(p);
    setJoinPasscode("");
  }

  function onLeave(silent?: boolean) {
    if (session) socket.emit("leaveParty", { partyId: session.partyId, memberId: session.memberId });
    clearSession();
    setSession(null);
    setParty(null);
    setMode("idle");
    if (!silent) setToast("");
    refreshParties();
    socket.emit("getParties");
  }

  const members = useMemo(() => {
    if (!party) return [];
    return Object.values(party.members || {}).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }, [party]);

  return (
    <main>
      <div className="topbarWrap">
      <div className="topbar">
        <div className="h1" style={{ margin: 0 }}>메랜큐</div>
        <div className="row" style={{ gap: 10 }}>
          {!authReady ? (
            <span className="badge">로그인 확인 중…</span>
          ) : user ? (
            <>
              <span className="badge">디스코드: {String(user.global_name || user.username)}</span>
              <button className="btn ghost" onClick={onLogout}>로그아웃</button>
            </>
          ) : (
            <a className="btn" href={loginUrl}>디스코드 로그인</a>
          )}
        </div>
      </div>
      <div className="toastStack">
        {toastItems.map((t) => (
          <div key={t.id} className={`toastItem ${t.kind || "info"}`}>{t.text}</div>
        ))}
      </div>
    </div>

      {mode === "idle" && (
        <div className="grid">
          <section className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700 }}>내 프로필</div>
              <span className="badge">
                서버: {API_BASE} · {health === "ok" ? "연결됨" : health === "fail" ? "연결 실패" : "확인중"}
              </span>
            </div>
            <div className="hr" />
            <div className="row">
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="label">닉네임</div>
                <input className="input" value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div className="label">직업</div>
                <select className="select" value={profile.job} onChange={(e) => setProfile((p) => ({ ...p, job: e.target.value as any }))}>
                  {JOBS.map((j) => (
                    <option key={j} value={j}>
                      {j}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">스공</div>
                <input
                  className="input"
                  style={{ minWidth: 140 }}
                  value={String(profile.power ?? 0)}
                  onChange={(e) => setProfile((p) => ({ ...p, power: clampPower(Number(e.target.value)) }))}
                />
              </div>
              <button className="btn" onClick={onSaveProfile} disabled={!user || !profile.name.trim()}>
                저장
              </button>
              <button className="btn ghost" onClick={pingHealth}>
                연결 테스트
              </button>
            </div>
            {toast && <div className="toast">{toast}</div>}
          </section>

          <section className="card">
            <div style={{ fontWeight: 700 }}>방 만들기</div>
            <div className="hr" />
            <div className="row">
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="label">파티 제목</div>
                <input className="input" value={titleInput} onChange={(e) => setTitleInput(e.target.value)} />
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="label">잠금 비밀번호</div>
                <input className="input opaque" value={createPasscode} onChange={(e) => setCreatePasscode(e.target.value)} />
              </div>
              <button className="btn" onClick={onCreate} disabled={!user || !profile.name.trim()}>
                파티 생성
              </button>
            </div>

            <div className="hr" />

            <div style={{ fontWeight: 700 }}>방 참가</div>
            <div className="row" style={{ marginTop: 8 }}>
              <input className="input" value={partyIdInput} onChange={(e) => setPartyIdInput(e.target.value)} placeholder="Party ID" />
              <button className="btn" onClick={() => onJoin()} disabled={!user || !profile.name.trim() || !partyIdInput.trim()}>
                참가
              </button>
            </div>
          </section>

          <section className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800 }}>파티 목록</div>
                <div className="label">실시간으로 갱신됩니다. (최대 6인)</div>
              </div>
              <button className="btn ghost" onClick={refreshParties}>
                새로고침
              </button>
            </div>
            <div className="hr" />

            {parties.length === 0 ? (
              <div className="label">현재 열린 파티가 없어요.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {parties.map((p) => (
                  <div key={p.id} className="member" style={{ alignItems: "flex-start", cursor: "pointer" }} onClick={() => openDetail(p)}>
                    <div style={{ width: "100%" }}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div>
                          <strong>{p.title}</strong>{" "}
                          {p.locked && <span className="badge" style={{ marginLeft: 6 }}>잠금</span>}
                          <div className="label">
                            ID: {p.id} · {p.membersCount}/{p.maxMembers}
                          </div>
                        </div>
                        <button
                          className="btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (p.locked) {
                              setDetail(p);
                            } else {
                              onJoin(p.id);
                            }
                          }}
                          disabled={!user || !profile.name.trim() || p.membersCount >= p.maxMembers}
                        >
                          참가
                        </button>
                      </div>
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {p.members?.slice(0, 6).map((m) => (
                          <span key={m.id} className="badge">
                            {m.name}({m.job}) · {formatPower(m.power)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {mode === "inParty" && party && session && (
        <div className="grid">
          <section className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{party.title}</div>
                <div className="label">
                  Party ID: <span style={{ color: "var(--text)", fontWeight: 700 }}>{party.id}</span> · {members.length}/{party.maxMembers}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn ghost" onClick={copyPartyId}>ID 복사</button>
                  <button className="btn ghost" onClick={copyInviteLink}>초대 링크 복사</button>
                </div>
                <div className="label" style={{ marginTop: 8 }}>
                  {isOwner ? "파티장" : "파티원"} · 미활동 시 파티는 자동 종료됩니다.
                </div>
              </div>
              <div className="row">
                <span className="badge">내 ID: {session.memberId.slice(0, 6)}…</span>
                <button className="btn ghost" onClick={() => onLeave(false)}>
                  나가기
                </button>
              </div>
            </div>

            <div className="hr" />

            <div style={{ fontWeight: 700, marginBottom: 8 }}>내 프로필 (파티 내 반영)</div>
            <div className="row">
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="label">닉네임</div>
                <input className="input" value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <div className="label">직업</div>
                <select className="select" value={profile.job} onChange={(e) => setProfile((p) => ({ ...p, job: e.target.value as any }))}>
                  {JOBS.map((j) => (
                    <option key={j} value={j}>
                      {j}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label">스공</div>
                <input
                  className="input"
                  style={{ minWidth: 140 }}
                  value={String(profile.power ?? 0)}
                  onChange={(e) => setProfile((p) => ({ ...p, power: clampPower(Number(e.target.value)) }))}
                />
              </div>
              <button className="btn" onClick={onUpdateMyProfileInParty} disabled={!user || !profile.name.trim()}>
                반영
              </button>
            </div>

            <div className="hr" />

            <div style={{ fontWeight: 700, marginBottom: 8 }}>버프</div>
            <div className="row">
              <div>
                <div className="label">심비</div>
                <input className="input small" value={simbi} onChange={(e) => setSimbi(e.target.value)} disabled={!isOwner} />
              </div>
              <div>
                <div className="label">뻥비</div>
                <input className="input small" value={bbeongbi} onChange={(e) => setBbeongbi(e.target.value)} disabled={!isOwner} />
              </div>
              <div>
                <div className="label">샾비</div>
                <input className="input small" value={shopbi} onChange={(e) => setShopbi(e.target.value)} disabled={!isOwner} />
              </div>
              {isOwner && (
                <button className="btn" onClick={onUpdateBuffs}>
                  적용
                </button>
              )}
              {!isOwner && <span className="badge">파티장만 수정 가능</span>}
            </div>

            <div className="hr" />

            <div style={{ fontWeight: 700, marginBottom: 8 }}>파티 제목</div>
            <div className="row">
              <input className="input" value={titleEdit} onChange={(e) => setTitleEdit(e.target.value)} disabled={!isOwner} />
              {isOwner && (
                <button className="btn" onClick={onRename}>
                  변경
                </button>
              )}
              {!isOwner && <span className="badge">파티장만 변경 가능</span>}
            </div>

            <div className="hr" />

            <div style={{ fontWeight: 700, marginBottom: 8 }}>파티 잠금</div>
            <div className="row">
              <label className="badge" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={lockEnabled}
                  onChange={(e) => setLockEnabled(e.target.checked)}
                  disabled={!isOwner}
                />
                잠금 사용
              </label>
              {lockEnabled && (
                <input type="password" className="input opaque" style={{ minWidth: 220 }} value={lockPasscode} onChange={(e) => setLockPasscode(e.target.value)} disabled={!isOwner} placeholder="비밀번호 입력" />
              )}
              {isOwner && (
                <button className="btn" onClick={onApplyLock}>
                  적용
                </button>
              )}
              {!isOwner && <span className="badge">파티장만 설정 가능</span>}
            </div>

            {toast && <div className="toast">{toast}</div>}
          </section>

          <section className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 700 }}>멤버</div>
                <div className="label">추방/파티장 위임은 파티장만 가능</div>
              </div>
              <span className="badge">총 {members.length}명</span>
            </div>

            <div className="hr" />

            <div style={{ display: "grid", gap: 10 }}>
              {members.map((m) => {
                const me = m.id === session.memberId;
                const owner = m.id === party.ownerId;
                return (
                  <div key={m.id} className="member">
                    <div>
                      <strong>
                        {m.name} {owner ? "(파티장)" : ""} {me ? "(나)" : ""}
                      </strong>
                      <div>
                        <small>
                          {m.job} · {formatPower(m.power)} · 최근 활동 {formatAgo(m.lastSeenAt)}
                        </small>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="badge">{m.id.slice(0, 6)}…</span>
                      {isOwner && !owner && !me && (
                        <>
                          <button className="btn ghost" onClick={() => onKick(m.id)}>
                            추방
                          </button>
                          <button className="btn" onClick={() => onTransferOwner(m.id)}>
                            위임
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hr" />
            <div className="label">* 멤버 30분 미활동이면 자동 제거. 파티는 미활동 시 자동 종료.</div>
          </section>
        </div>
      )}

      {detail && (
        <Modal onClose={() => setDetail(null)}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{detail.title}</div>
              <div className="label">
                ID: {detail.id} · {detail.membersCount}/{detail.maxMembers} {detail.locked ? "· 잠금" : ""}
              </div>
            </div>
            <button className="btn ghost" onClick={() => setDetail(null)}>
              닫기
            </button>
          </div>
          <div className="hr" />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {detail.members?.map((m) => (
              <span key={m.id} className="badge">
                {m.name}({m.job}) · {formatPower(m.power)}
              </span>
            ))}
          </div>

          <div className="hr" />

          {detail.locked && (
            <div className="row">
              <div style={{ flex: 1 }}>
                <div className="label">비밀번호</div>
                <input type="password" className="input opaque" value={joinPasscode} onChange={(e) => setJoinPasscode(e.target.value)} />
              </div>
              <button className="btn" onClick={() => onJoin(detail.id, joinPasscode)} disabled={!user || !profile.name.trim()}>
                참가
              </button>
            </div>
          )}

          {!detail.locked && (
            <button className="btn" onClick={() => onJoin(detail.id)} disabled={!profile.name.trim() || detail.membersCount >= detail.maxMembers}>
              참가
            </button>
          )}

          {toast && <div className="toast">{toast}</div>}
        </Modal>
      )}
    </main>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 50
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="card"
        style={{ width: "min(820px, 96vw)", maxHeight: "85vh", overflow: "auto" }}
      >
        {children}
      </div>
    </div>
  );
}

function safeProfile(p: Profile) {
  const name = String(p.name ?? "").trim().slice(0, 20);
  const job = (p.job ?? "전사") as any;
  const power = clampPower(Number(p.power ?? 0));
  if (!name) throw new Error("닉네임을 입력하세요");
  return { name, job, power };
}

function clampBuff(v: string) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 9999) return 9999;
  return n;
}

function clampPower(v: number) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 99999) return 99999;
  return n;
}

function formatPower(v: number) {
  const n = Math.trunc(Number(v ?? 0));
  return String(n);
}

function formatAgo(t: number) {
  const diff = Date.now() - t;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return `${h}시간 전`;
}

function prettyErrorCode(code: string) {
  if (code === "PARTY_FULL") return "이미 파티가 가득 찼습니다.";
  if (code === "PARTY_LOCKED") return "잠긴 파티입니다. 비밀번호를 입력하세요.";
  if (code === "INVALID_PASSCODE") return "비밀번호가 틀렸습니다.";
  if (code === "PASSCODE_REQUIRED") return "비밀번호를 입력해야 잠금을 켤 수 있어요.";
  if (code === "FORBIDDEN") return "권한이 없습니다.";
  if (code === "CANNOT_KICK_OWNER") return "파티장은 추방할 수 없습니다.";
  return code;
}

function prettyFetchError(msg?: string) {
  const m = String(msg ?? "");
  if (m.includes("PARTY_FULL")) return "이미 파티가 가득 찼습니다.";
  if (m.includes("PARTY_LOCKED")) return "잠긴 파티입니다. 비밀번호를 입력하세요.";
  if (m.includes("INVALID_PASSCODE")) return "비밀번호가 틀렸습니다.";
  if (m.includes("PASSCODE_REQUIRED")) return "비밀번호를 입력해야 잠금을 켤 수 있어요.";
  if (m.includes("FORBIDDEN")) return "권한이 없습니다.";
  if (m.includes("Failed to fetch") || m.includes("NetworkError")) {
    return "Failed to fetch: 서버에 연결을 못했어요. (서버 실행/포트/ORIGIN/CORS/https↔http 확인)";
  }
  return m || "요청 실패";
}

async function safeCopy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
