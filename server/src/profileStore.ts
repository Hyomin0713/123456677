import fs from "node:fs";
import path from "node:path";
import type { Job } from "./types.js";

export type SavedProfile = { name: string; job: Job; power: number };

type Persisted = {
  version: 1;
  savedAt: number;
  profiles: Record<string, SavedProfile>; // discordId -> profile
};

function now() {
  return Date.now();
}

export class ProfileStore {
  private profiles: Record<string, SavedProfile> = {};
  private persistFile = process.env.PROFILES_FILE
    ? path.resolve(process.env.PROFILES_FILE)
    : path.resolve(process.cwd(), "data", "profiles.json");

  private persistTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  private scheduleSave() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.save();
    }, 250);
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      const payload: Persisted = { version: 1, savedAt: now(), profiles: this.profiles };
      fs.writeFileSync(this.persistFile, JSON.stringify(payload), "utf-8");
    } catch (e) {
      console.error("[profiles] save failed:", e);
    }
  }

  private load() {
    try {
      if (!fs.existsSync(this.persistFile)) return;
      const raw = fs.readFileSync(this.persistFile, "utf-8");
      const parsed = JSON.parse(raw) as Persisted;
      if (!parsed || parsed.version !== 1 || typeof parsed.profiles !== "object") return;
      this.profiles = parsed.profiles || {};
      console.log(`[profiles] loaded ${Object.keys(this.profiles).length} profiles from disk`);
    } catch (e) {
      console.error("[profiles] load failed:", e);
    }
  }

  get(discordId: string): SavedProfile | null {
    return this.profiles[discordId] ?? null;
  }

  set(discordId: string, profile: SavedProfile) {
    this.profiles[discordId] = profile;
    this.scheduleSave();
  }
}

export const PROFILES = new ProfileStore();
