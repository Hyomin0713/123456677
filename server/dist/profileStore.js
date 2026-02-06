import fs from "node:fs";
import path from "node:path";
function now() {
    return Date.now();
}
export class ProfileStore {
    profiles = {};
    persistFile = process.env.PROFILES_FILE
        ? path.resolve(process.env.PROFILES_FILE)
        : path.resolve(process.cwd(), "data", "profiles.json");
    persistTimer = null;
    constructor() {
        this.load();
    }
    scheduleSave() {
        if (this.persistTimer)
            return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.save();
        }, 250);
    }
    save() {
        try {
            fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
            const payload = { version: 1, savedAt: now(), profiles: this.profiles };
            fs.writeFileSync(this.persistFile, JSON.stringify(payload), "utf-8");
        }
        catch (e) {
            console.error("[profiles] save failed:", e);
        }
    }
    load() {
        try {
            if (!fs.existsSync(this.persistFile))
                return;
            const raw = fs.readFileSync(this.persistFile, "utf-8");
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 1 || typeof parsed.profiles !== "object")
                return;
            this.profiles = parsed.profiles || {};
            console.log(`[profiles] loaded ${Object.keys(this.profiles).length} profiles from disk`);
        }
        catch (e) {
            console.error("[profiles] load failed:", e);
        }
    }
    get(discordId) {
        return this.profiles[discordId] ?? null;
    }
    set(discordId, profile) {
        this.profiles[discordId] = profile;
        this.scheduleSave();
    }
}
export const PROFILES = new ProfileStore();
