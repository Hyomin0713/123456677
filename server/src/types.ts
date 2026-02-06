export type Job = "전사" | "도적" | "궁수" | "마법사";

export type Buffs = {
  simbi: number;    // 심비
  bbeongbi: number; // 뻥비
  shopbi: number;   // 샾비
};

export type Member = {
  id: string;
  name: string;
  job: Job;
  power: number;     // 스공
  joinedAt: number;
  lastSeenAt: number;
};

export type PartyLock = {
  enabled: boolean;
  // sha256(partyId + ":" + passcode)
  passcodeHash?: string;
};

export type Party = {
  id: string;
  title: string;
  ownerId: string; // 파티장(생성자/위임)
  maxMembers: number; // 기본 6
  lock: PartyLock;

  createdAt: number;
  updatedAt: number;
  expiresAt: number; // 파티 자체 만료(미활동 시 자동 종료)

  // 0명 상태가 유지될 때 자동 삭제를 위해 사용 (optional)
  emptySinceAt?: number;

  buffs: Buffs;
  members: Record<string, Member>;
};
