import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ChannelType, type Client, type Guild, type GuildBasedChannel } from "discord.js";
import { DATA_DIR, getSettings } from "./store.js";
import { sendLog } from "./log.js";

interface SnapRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
}
interface SnapChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  rateLimit: number;
  bitrate: number;
  userLimit: number;
  overwrites: { id: string; type: number; allow: string; deny: string }[];
}
interface Snapshot {
  at: number;
  roles: SnapRole[];
  channels: SnapChannel[];
}

const DIR = path.join(DATA_DIR, "snapshots");
const KEEP_MS = 7 * 86_400_000;
const MAX_SNAPSHOTS = 400;

const KEEP_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
]);

const file = (guildId: string) => path.join(DIR, `${guildId}.json`);

function load(guildId: string): Snapshot[] {
  try {
    return JSON.parse(fs.readFileSync(file(guildId), "utf8"));
  } catch {
    return [];
  }
}
function store(guildId: string, snaps: Snapshot[]) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(guildId), JSON.stringify(snaps));
  } catch (e) {
    console.error("スナップショットの保存に失敗:", e);
  }
}

// ===== スナップショット =====
const frozen = new Map<string, number>();
/** 大量削除などを検知した直後は、壊れた状態を保存しないよう一時停止する */
export const freezeSnapshots = (guildId: string, ms = 30 * 60_000) => frozen.set(guildId, Date.now() + ms);

async function build(guild: Guild): Promise<Snapshot> {
  await guild.roles.fetch().catch(() => {});
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const roles: SnapRole[] = guild.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
    }));
  const chs: SnapChannel[] = [];
  for (const c of channels.values()) {
    if (!c || !KEEP_TYPES.has(c.type)) continue;
    const x = c as any;
    chs.push({
      id: c.id,
      name: c.name,
      type: c.type,
      parentId: x.parentId ?? null,
      position: x.rawPosition ?? 0,
      topic: x.topic ?? null,
      nsfw: !!x.nsfw,
      rateLimit: x.rateLimitPerUser ?? 0,
      bitrate: x.bitrate ?? 0,
      userLimit: x.userLimit ?? 0,
      overwrites: [...(x.permissionOverwrites?.cache?.values() ?? [])].map((o: any) => ({
        id: o.id,
        type: o.type,
        allow: o.allow.bitfield.toString(),
        deny: o.deny.bitfield.toString(),
      })),
    });
  }
  return { at: Date.now(), roles, channels: chs };
}

const digest = (s: Snapshot) =>
  createHash("sha1").update(JSON.stringify({ r: s.roles, c: s.channels })).digest("hex");

/** 構成が変わっていれば保存する(7日分だけ残す) */
export async function takeSnapshot(guild: Guild): Promise<boolean> {
  if ((frozen.get(guild.id) ?? 0) > Date.now()) return false;
  const snap = await build(guild);
  const all = load(guild.id).filter((s) => Date.now() - s.at < KEEP_MS);
  if (all.length && digest(all[all.length - 1]) === digest(snap)) return false;
  all.push(snap);
  while (all.length > MAX_SNAPSHOTS) all.shift();
  store(guild.id, all);
  return true;
}

export const listSnapshots = (guildId: string) => load(guildId).filter((s) => Date.now() - s.at < KEEP_MS);

// ===== 復元 =====
export interface RestoreResult {
  snapAt: number;
  rolesCreated: number;
  channelsCreated: number;
  failed: number;
}

/** minutesAgo分より前に撮ったスナップショットのうち一番新しいものから、消えた物を作り直す */
export async function restore(guild: Guild, minutesAgo = 10): Promise<RestoreResult | null> {
  const limit = Date.now() - minutesAgo * 60_000;
  const snap = [...listSnapshots(guild.id)].reverse().find((s) => s.at <= limit);
  if (!snap) return null;

  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});
  const res: RestoreResult = { snapAt: snap.at, rolesCreated: 0, channelsCreated: 0, failed: 0 };

  // ロール(古いIDと新しいIDの対応表を作る)
  const roleMap = new Map<string, string>([[guild.id, guild.id]]);
  for (const r of [...snap.roles].sort((a, b) => a.position - b.position)) {
    if (guild.roles.cache.has(r.id)) {
      roleMap.set(r.id, r.id);
      continue;
    }
    try {
      const created = await guild.roles.create({
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: BigInt(r.permissions),
        reason: "ロールバック",
      });
      roleMap.set(r.id, created.id);
      res.rolesCreated++;
    } catch {
      res.failed++;
    }
  }

  // チャンネル(カテゴリを先に)
  const chMap = new Map<string, string>();
  for (const c of snap.channels) if (guild.channels.cache.has(c.id)) chMap.set(c.id, c.id);
  const ordered = [...snap.channels].sort(
    (a, b) => Number(b.type === ChannelType.GuildCategory) - Number(a.type === ChannelType.GuildCategory) || a.position - b.position,
  );
  for (const c of ordered) {
    if (guild.channels.cache.has(c.id)) continue;
    const overwrites = c.overwrites
      .map((o) => ({
        id: o.type === 0 ? roleMap.get(o.id) : guild.members.cache.has(o.id) ? o.id : undefined,
        type: o.type,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      }))
      .filter((o) => o.id);
    const isVoice = c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice;
    const opts: any = {
      name: c.name,
      type: c.type,
      parent: c.parentId ? (chMap.get(c.parentId) ?? null) : null,
      position: c.position,
      permissionOverwrites: overwrites,
      reason: "ロールバック",
    };
    if (c.type !== ChannelType.GuildCategory && !isVoice) {
      opts.topic = c.topic ?? undefined;
      opts.nsfw = c.nsfw;
      opts.rateLimitPerUser = c.rateLimit;
    }
    if (isVoice) {
      opts.bitrate = Math.min(c.bitrate || 64000, guild.maximumBitrate);
      opts.userLimit = c.userLimit;
    }
    try {
      const created = (await guild.channels.create(opts)) as GuildBasedChannel;
      chMap.set(c.id, created.id);
      res.channelsCreated++;
    } catch {
      res.failed++;
    }
  }
  return res;
}

// ===== 自動復元(検知の直後に呼ぶ) =====
const pending = new Set<string>();
export function autoRestore(guild: Guild) {
  freezeSnapshots(guild.id);
  if (!getSettings(guild.id).rollback.autoRestore || pending.has(guild.id)) return;
  pending.add(guild.id);
  setTimeout(async () => {
    pending.delete(guild.id);
    const r = await restore(guild, 10).catch(() => null);
    await sendLog(
      guild,
      "♻️ 自動ロールバック",
      r
        ? `<t:${Math.floor(r.snapAt / 1000)}:f> の状態から復元しました。\nロール${r.rolesCreated}個 / チャンネル${r.channelsCreated}個を再作成(失敗${r.failed})`
        : "復元に使えるスナップショットがありませんでした。",
      0x2ecc71,
    );
  }, 5000).unref();
}

export function registerRollback(client: Client) {
  const tick = async () => {
    for (const g of client.guilds.cache.values()) await takeSnapshot(g).catch(() => {});
  };
  client.once("ready", () => setTimeout(() => void tick(), 30_000).unref());
  setInterval(() => void tick(), 10 * 60_000).unref();
}
