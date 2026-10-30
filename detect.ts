import type { Guild } from "discord.js";
import { getSettings, type DetOverride } from "./store.js";
import { sendLog } from "./log.js";

export type Group = "user" | "bot";
type Range = [number, number];

export interface Def {
  key: string;
  label: string;
  group: Group;
  enabled: boolean;
  window?: number; // 秒
  threshold?: number;
  duration?: number; // 分
  count?: number;
  steps?: number[]; // 繰り返すと重くなる処罰(分。0=警告のみ)
  ranges: { window?: Range; threshold?: Range; duration?: Range; count?: Range };
  countLabel?: string;
  note?: string;
}

const R = (a: number, b: number): Range => [a, b];

export const DEFS: Def[] = [
  { key: "messageSpam", label: "メッセージ連投", group: "user", enabled: true, window: 10, threshold: 6, steps: [1, 5, 60], ranges: { window: R(3, 120), threshold: R(3, 50) } },
  { key: "duplicate", label: "同一内容の連投", group: "user", enabled: true, window: 7, threshold: 3, duration: 10, ranges: { window: R(1, 60), threshold: R(2, 20), duration: R(1, 10080) } },
  { key: "pollSpam", label: "投票(ポール)連投", group: "user", enabled: true, window: 60, threshold: 3, duration: 180, ranges: { window: R(10, 600), threshold: R(2, 20), duration: R(60, 1440) } },
  { key: "appSpam", label: "外部アプリ連投", group: "user", enabled: true, window: 10, threshold: 3, duration: 60, ranges: { window: R(3, 120), threshold: R(2, 30) } },
  { key: "vcSpam", label: "VC入退室連投", group: "user", enabled: true, window: 10, threshold: 3, duration: 10, ranges: { window: R(3, 120), threshold: R(2, 30), duration: R(1, 10080) } },
  { key: "mentionSpam", label: "メンション連投", group: "user", enabled: true, window: 10, threshold: 3, duration: 10, ranges: { window: R(3, 120), threshold: R(2, 30), duration: R(1, 10080) } },
  { key: "massMention", label: "大量メンション", group: "user", enabled: true, threshold: 6, duration: 30, ranges: { threshold: R(3, 50), duration: R(1, 10080) } },
  { key: "everyone", label: "@everyone/@here の無断使用", group: "user", enabled: true, duration: 30, ranges: {}, note: "固定" },
  { key: "invite", label: "招待リンク", group: "user", enabled: true, steps: [5, 30, 60], ranges: {}, note: "固定(文字を崩した招待も検知)" },
  { key: "shortLink", label: "短縮/リダイレクトURL経由の招待", group: "user", enabled: true, steps: [5, 30, 60], ranges: {}, note: "/短縮リンクブロック で切替" },
  { key: "linkPreview", label: "リンクプレビュー検査", group: "user", enabled: true, ranges: {}, note: "固定" },
  { key: "reactionSpam", label: "リアクション連投", group: "user", enabled: true, window: 600, threshold: 5, count: 10, duration: 180, countLabel: "1メッセージあたりのリアクション数", ranges: { window: R(60, 3600), threshold: R(2, 30), count: R(5, 50), duration: R(60, 1440) } },
  { key: "imageCross", label: "複数チャンネルへの画像連投", group: "user", enabled: true, window: 7, threshold: 3, duration: 1440, ranges: { window: R(3, 60), threshold: R(2, 20), duration: R(1, 10080) } },
  { key: "imageSame", label: "同一画像の拡散", group: "user", enabled: true, window: 120, threshold: 3, duration: 1440, ranges: { window: R(30, 600), threshold: R(2, 20), duration: R(1, 10080) } },
  { key: "raid", label: "レイドモード", group: "user", enabled: true, window: 10, threshold: 3, count: 60, countLabel: "自動解除までの秒数", ranges: { window: R(5, 60), threshold: R(2, 20), count: R(30, 600) }, note: "荒らし検知が短時間に複数人で起きたら発動" },
  { key: "introDup", label: "自己紹介の重複", group: "user", enabled: true, ranges: {}, note: "固定(前の投稿を削除)" },
  { key: "threadSpam", label: "スレッド連投", group: "user", enabled: true, window: 60, threshold: 3, duration: 180, ranges: { window: R(10, 600), threshold: R(2, 20), duration: R(60, 1440) } },
  { key: "helpSpam", label: "!help 連投", group: "user", enabled: true, window: 30, threshold: 3, duration: 180, ranges: { window: R(5, 300), threshold: R(2, 20), duration: R(60, 1440) } },
  { key: "tokenLeak", label: "Discordトークンの流出", group: "user", enabled: true, duration: 60, ranges: {}, note: "固定" },
  { key: "crash", label: "クラッシュ文字列", group: "user", enabled: true, steps: [0, 10, 60], ranges: {}, note: "固定(警告→10分→1時間)" },
  { key: "longMessage", label: "長文メッセージ", group: "user", enabled: false, count: 1000, steps: [0, 60], countLabel: "最大文字数", ranges: { count: R(100, 2000) } },
  { key: "massJoin", label: "大量参加(ログのみ)", group: "user", enabled: true, window: 10, threshold: 5, ranges: { window: R(3, 300), threshold: R(2, 50) } },

  { key: "botChannelDelete", label: "BOTによるチャンネル大量削除", group: "bot", enabled: true, window: 5, threshold: 4, ranges: { window: R(3, 60), threshold: R(2, 20) } },
  { key: "botChannelCreate", label: "BOTによるチャンネル大量作成", group: "bot", enabled: true, window: 10, threshold: 8, ranges: { window: R(3, 60), threshold: R(2, 30) } },
  { key: "botRoleDelete", label: "BOTによるロール大量削除", group: "bot", enabled: true, window: 10, threshold: 4, ranges: { window: R(3, 60), threshold: R(2, 30) } },
  { key: "botMassBan", label: "BOTによる大量BAN", group: "bot", enabled: true, window: 30, threshold: 3, ranges: { window: R(5, 300), threshold: R(2, 20) } },
  { key: "botMsgSpam", label: "BOTのメッセージ連投", group: "bot", enabled: true, window: 10, threshold: 7, duration: 60, ranges: { window: R(3, 120), threshold: R(2, 50) }, note: "@everyone付きならBAN、なければ1時間タイムアウト" },
  { key: "botEveryone", label: "BOTの@everyone使用", group: "bot", enabled: true, ranges: {}, note: "即BAN(ON/OFFのみ)" },
  { key: "webhookSpam", label: "Webhook連投", group: "bot", enabled: true, window: 5, threshold: 3, ranges: { window: R(3, 60), threshold: R(2, 30) }, note: "/webhookspam でも切替" },
];

export const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

function overrides(guildId: string, group: Group): Record<string, DetOverride> {
  const s = getSettings(guildId);
  return group === "user" ? s.anti.overrides : s.botGuard.overrides;
}

/** 既定値に上書きを重ねた、実際に使う設定 */
export function cfg(guildId: string, key: string) {
  const d = DEF_BY_KEY.get(key)!;
  const o = overrides(guildId, d.group)[key] ?? {};
  return {
    enabled: o.enabled ?? d.enabled,
    window: o.window ?? d.window ?? 0,
    threshold: o.threshold ?? d.threshold ?? 0,
    duration: o.duration ?? d.duration ?? 0,
    count: o.count ?? d.count ?? 0,
    steps: d.steps ?? [],
  };
}

/** 全体スイッチと個別スイッチの両方がONか(全体スイッチが優先) */
export function isOn(guildId: string, key: string): boolean {
  const d = DEF_BY_KEY.get(key)!;
  const s = getSettings(guildId);
  const global = d.group === "user" ? s.anti.enabled : s.botGuard.enabled;
  if (!global) return false;
  if (key === "shortLink") return s.anti.shortLinkBlock && cfg(guildId, key).enabled;
  if (key === "webhookSpam") return s.botGuard.webhookSpam && cfg(guildId, key).enabled;
  return cfg(guildId, key).enabled;
}

// ===== 繰り返すと重くなる処罰 =====
const offenses = new Map<string, { n: number; at: number }>();

/** 24時間以内の違反回数に応じて、steps の何番目を使うか選ぶ */
export function nextStep(guildId: string, userId: string, key: string, steps: number[]): number {
  const k = `${guildId}:${userId}:${key}`;
  const now = Date.now();
  const cur = offenses.get(k);
  const n = cur && now - cur.at < 24 * 3600_000 ? cur.n : 0;
  offenses.set(k, { n: n + 1, at: now });
  return steps[Math.min(n, steps.length - 1)];
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of offenses) if (now - v.at > 24 * 3600_000) offenses.delete(k);
}, 600_000).unref();

// ===== 処罰 =====
export async function timeoutMember(guild: Guild, userId: string, minutes: number, reason: string): Promise<boolean> {
  if (minutes <= 0) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || !member.moderatable) return false;
  const ms = Math.min(minutes, 40320) * 60_000; // Discordの上限は28日
  return member.timeout(ms, reason).then(() => true).catch(() => false);
}

// ===== レイドモード =====
const recentFlagged = new Map<string, Map<string, number>>(); // guild -> user -> time
const raidUntil = new Map<string, number>();

export const inRaid = (guildId: string) => (raidUntil.get(guildId) ?? 0) > Date.now();

/** 荒らし検知にかかったユーザーを記録し、短時間に複数人なら一定時間レイドモードにする */
export async function noteFlagged(guild: Guild, userId: string) {
  if (!isOn(guild.id, "raid")) return;
  const c = cfg(guild.id, "raid");
  const now = Date.now();
  const m = recentFlagged.get(guild.id) ?? new Map<string, number>();
  m.set(userId, now);
  for (const [u, t] of m) if (now - t > c.window * 1000) m.delete(u);
  recentFlagged.set(guild.id, m);
  if (m.size >= c.threshold && !inRaid(guild.id)) {
    raidUntil.set(guild.id, now + c.count * 1000);
    const ids = [...m.keys()];
    await Promise.all(ids.map((id) => timeoutMember(guild, id, Math.max(1, Math.ceil(c.count / 60)), "レイドモード")));
    await sendLog(
      guild,
      "🚨 レイドモード発動",
      `${c.window}秒以内に${m.size}人が荒らし検知にかかりました。\n` +
        `${c.count}秒間、連投検知のしきい値を半分にして警戒します(自動解除)。\n` +
        `対象: ${ids.map((i) => `<@${i}>`).join(" ")}`,
      0xc0392b,
      "punish",
    );
  }
}
