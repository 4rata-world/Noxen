import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR || "./data";

export type LogType = "join" | "message" | "admin" | "punish" | "vc";
export type WordAction = "BAN" | "KICK" | "TIMEOUT" | "DELETEMESSAGE";

/** 検知ごとの上書き設定(変更した項目だけ保存される) */
export interface DetOverride {
  enabled?: boolean;
  window?: number; // 秒
  threshold?: number;
  duration?: number; // 分
  count?: number; // 検知ごとの補助値(リアクション数/最大文字数/解除秒数)
}

export interface GuildSettings {
  logChannelId: string; // 種別ごとの設定がないときの送信先
  logChannels: Partial<Record<LogType, string>>;
  joinNoticeChannelId: string;
  inviteLogDest: "join" | "notice" | "off";
  introChannelId: string;
  reportChannelId: string;
  restartLog: boolean;

  whitelist: string[]; // 検知の対象外にするユーザーID
  blacklist: string[]; // 参加した瞬間にBANするID(ユーザー/Bot)

  // ===== チャンネル設定 =====
  sticky: Record<string, { text: string; lastId: string }>;
  notSpeak: string[]; // コマンド以外の発言を禁止するチャンネル
  linkAllowed: string[]; // 招待リンクを許可するチャンネル
  excluded: string[]; // 荒らし対策の対象外チャンネル
  webhookExcluded: string[]; // Webhook検知の対象外チャンネル
  promoChannels: string[]; // 宣伝リミットの対象チャンネル
  promoLog: Record<string, { c: number; t: number }>;

  // ===== モデレーション =====
  words: { word: string; action: WordAction }[];
  rateLimits: Record<string, { windowMin: number; max: number; durMin: number }>;
  dmBlock: boolean;

  // ===== 荒らし対策(ユーザー) =====
  anti: {
    enabled: boolean;
    shortLinkBlock: boolean;
    scamLinkBlock: boolean;
    overrides: Record<string, DetOverride>;
  };

  // ===== 荒らし対策(BOT) =====
  botGuard: {
    enabled: boolean;
    inviteBlock: boolean;
    webhookSpam: boolean;
    exceptions: string[]; // 監視から外すBotのID
    overrides: Record<string, DetOverride>;
  };

  rollback: { autoRestore: boolean };

  // ===== Securo Warden系 =====
  antinuke: {
    enabled: boolean;
    limit: number;
    windowSec: number;
    punishment: "ban" | "kick" | "strip";
    alertMode: "normal" | "high"; // highはホワイトリストの人も監視する
  };
  inviteSafe: {
    enabled: boolean;
    limit: number;
    windowSec: number;
    lockedRoleIds: string[];
  };
  imageHashes: string[];
  guard: {
    enabled: boolean;
    minAccountDays: number;
    kickDefaultAvatar: boolean;
    raidJoins: number;
    raidWindowSec: number;
    lockdownMin: number;
  };
  botActivity: Record<string, number>;
  botTrackingSince: number;
}

const defaults = (): GuildSettings => ({
  logChannelId: "",
  logChannels: {},
  joinNoticeChannelId: "",
  inviteLogDest: "off",
  introChannelId: "",
  reportChannelId: "",
  restartLog: false,
  whitelist: [],
  blacklist: [],
  sticky: {},
  notSpeak: [],
  linkAllowed: [],
  excluded: [],
  webhookExcluded: [],
  promoChannels: [],
  promoLog: {},
  words: [],
  rateLimits: {},
  dmBlock: false,
  anti: { enabled: true, shortLinkBlock: true, scamLinkBlock: true, overrides: {} },
  botGuard: { enabled: true, inviteBlock: true, webhookSpam: true, exceptions: [], overrides: {} },
  rollback: { autoRestore: false },
  antinuke: { enabled: true, limit: 3, windowSec: 5, punishment: "strip", alertMode: "normal" },
  inviteSafe: { enabled: false, limit: 5, windowSec: 30, lockedRoleIds: [] },
  imageHashes: [],
  guard: {
    enabled: false,
    minAccountDays: 3,
    kickDefaultAvatar: false,
    raidJoins: 8,
    raidWindowSec: 10,
    lockdownMin: 10,
  },
  botActivity: {},
  botTrackingSince: 0,
});

const FILE = path.join(DATA_DIR, "settings.json");
let db: Record<string, GuildSettings> = {};
try {
  db = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  // 初回は空
}

function merge(base: any, over: any): any {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over ?? base;
  const out: any = { ...base };
  for (const k of Object.keys(over ?? {})) {
    out[k] = k in base ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

export function getSettings(guildId: string): GuildSettings {
  db[guildId] = merge(defaults(), db[guildId] ?? {});
  return db[guildId];
}

let saveTimer: NodeJS.Timeout | null = null;

/** 書き込みはまとめて(0.5秒デバウンス) */
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error("設定の保存に失敗:", e);
    }
  }, 500);
}
