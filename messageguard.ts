import { createHash } from "node:crypto";
import { Events, PermissionFlagsBits, type Client, type GuildMember, type Message } from "discord.js";
import { getSettings, save, type WordAction } from "./store.js";
import { DEF_BY_KEY, cfg, inRaid, isOn, nextStep, noteFlagged, timeoutMember } from "./detect.js";
import { sendLog } from "./log.js";
import { hit, isExempt, markBotDeleted } from "./util.js";
import { findSimilar, hashFromUrl } from "./images.js";

type GMessage = Message<true>;

// ===== 判定用の正規表現 =====
const INVITE_RE = /(discord\.?gg|discord(?:app)?\.?com\/invite|dsc\.gg|discord\.me|discord\.io)\/[a-z0-9-]{2,}/i;
const TOKEN_RE = /\b(?:mfa\.[\w-]{80,95}|[\w-]{24,28}\.[\w-]{6}\.[\w-]{27,38})\b/;
// 結合文字・制御文字・双方向制御文字の異常な連続など、クライアントを重くする文字列
const CRASH_RE =
  /[̀-ͯ҃-҉֑-ֽً-ٟ]{25,}|[​-‏‪-‮⁠-⁯]{30,}|\u0000/;
const URL_RE = /https?:\/\/[^\s<>()\]]+/gi;

const SHORT_HOSTS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "v.gd", "ow.ly", "cutt.ly", "rb.gy",
  "x.gd", "t.ly", "buff.ly", "s.id", "rebrand.ly", "shorturl.at", "lnkd.in", "soo.gd", "u.nu",
]);

/** 文字を崩した招待(空白・(dot)・全角ピリオドなど)も拾うために正規化する */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\(dot\)|\[dot\]|\[\.\]|\(\.\)|。|．|｡/g, ".")
    .replace(/\s+/g, "");
}

export function hasInvite(text: string): boolean {
  return INVITE_RE.test(text) || INVITE_RE.test(normalize(text));
}

/** 既知の短縮URLだけを辿って、最終的に招待リンクに着くか調べる(任意のURLには接続しない) */
export async function resolvesToInvite(url: string): Promise<boolean> {
  let cur = url;
  for (let i = 0; i < 4; i++) {
    let host: string;
    try {
      host = new URL(cur).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return false;
    }
    if (!SHORT_HOSTS.has(host)) return false;
    try {
      const res = await fetch(cur, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000) });
      const loc = res.headers.get("location");
      if (!loc) return false;
      cur = new URL(loc, cur).toString();
      if (INVITE_RE.test(cur)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

// ===== 詐欺サイトリスト(SCAM_LIST_URL に1行1ドメインのテキストを指定) =====
let scamDomains = new Set<string>();
async function loadScamList() {
  const url = process.env.SCAM_LIST_URL;
  if (!url) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return;
    const set = new Set<string>();
    for (const line of (await res.text()).split(/\r?\n/)) {
      const d = line.replace(/#.*/, "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (d) set.add(d);
    }
    if (set.size) scamDomains = set;
  } catch {
    // 取得失敗時は前回のリストを使い続ける
  }
}
const isScamHost = (host: string) => {
  const h = host.toLowerCase();
  for (const d of scamDomains) if (h === d || h.endsWith("." + d)) return true;
  return false;
};

// ===== 直近の発言バッファ =====
type Rec = { at: number; msg: GMessage; content: string; mention: boolean };
const recent = new Map<string, Rec[]>();
const images = new Map<string, { at: number; msg: GMessage; channelId: string; hash?: string }[]>();
const key = (m: GMessage) => `${m.guildId}:${m.author.id}`;

function pushRecent(m: GMessage): Rec[] {
  const now = Date.now();
  const arr = (recent.get(key(m)) ?? []).filter((r) => now - r.at < 120_000);
  arr.push({
    at: now,
    msg: m,
    content: m.content,
    mention: m.mentions.users.size + m.mentions.roles.size > 0,
  });
  recent.set(key(m), arr);
  return arr;
}

const fmt = (min: number) =>
  min >= 1440 ? `${Math.round(min / 144) / 10}日` : min >= 60 ? `${Math.round(min / 6) / 10}時間` : `${min}分`;

async function del(msgs: GMessage[]) {
  const uniq = [...new Map(msgs.map((x) => [x.id, x])).values()];
  markBotDeleted(uniq.map((x) => x.id));
  await Promise.allSettled(uniq.map((x) => x.delete()));
}

interface ActOpts {
  del?: GMessage[];
  minutes?: number;
  steps?: number[];
  escKey?: string;
  label?: string;
}

/** メッセージ削除 → 処罰 → ログ → レイド記録 までを共通処理にする */
async function act(m: GMessage, detKey: string, reason: string, o: ActOpts = {}) {
  const guild = m.guild;
  const def = DEF_BY_KEY.get(detKey);
  let minutes = o.minutes;
  if (minutes === undefined) {
    const steps = o.steps ?? def?.steps ?? [];
    minutes = steps.length
      ? nextStep(guild.id, m.author.id, o.escKey ?? detKey, steps)
      : def
        ? cfg(guild.id, detKey).duration
        : 10;
  }
  await del(o.del ?? [m]);

  let result = "警告";
  if (minutes > 0) {
    const ok = await timeoutMember(guild, m.author.id, minutes, `荒らし対策: ${reason}`);
    result = ok ? `${fmt(minutes)}タイムアウト` : "タイムアウト失敗(権限/ロール順位を確認)";
  } else if ("send" in m.channel) {
    const w = await m.channel.send(`${m.author} 警告: ${reason}`).catch(() => null);
    if (w) setTimeout(() => void w.delete().catch(() => {}), 10_000).unref();
  }
  await sendLog(
    guild,
    `🛡️ ${o.label ?? def?.label ?? "荒らし対策"}`,
    `**ユーザー**: <@${m.author.id}> (${m.author.tag})\n**理由**: ${reason}\n` +
      `**チャンネル**: <#${m.channelId}>\n**処置**: メッセージ削除 / ${result}`,
    0xe74c3c,
    "punish",
  );
  void noteFlagged(guild, m.author.id);
}

// ===== NGワード =====
async function applyWord(m: GMessage, word: string, action: WordAction) {
  const guild = m.guild;
  await del([m]);
  let result = "メッセージ削除";
  if (action === "TIMEOUT") {
    result += (await timeoutMember(guild, m.author.id, 10, `NGワード: ${word}`)) ? " / 10分タイムアウト" : " / タイムアウト失敗";
  } else if (action === "KICK") {
    const ok = await m.member?.kick(`NGワード: ${word}`).then(() => true).catch(() => false);
    result += ok ? " / キック" : " / キック失敗";
  } else if (action === "BAN") {
    const ok = await guild.members.ban(m.author.id, { reason: `NGワード: ${word}` }).then(() => true).catch(() => false);
    result += ok ? " / BAN" : " / BAN失敗";
  }
  await sendLog(
    guild,
    "🚫 NGワード",
    `**ユーザー**: <@${m.author.id}> (${m.author.tag})\n**ワード**: ||${word}||\n**チャンネル**: <#${m.channelId}>\n**処置**: ${result}`,
    0xe74c3c,
    "punish",
  );
  void noteFlagged(guild, m.author.id);
}

/** 内容だけで判定できるルール(投稿時と編集時の両方で使う)。削除したら true */
async function contentRules(m: GMessage, extraText = ""): Promise<boolean> {
  const g = m.guild.id;
  const s = getSettings(g);
  const text = `${m.content}\n${extraText}`;

  if (isOn(g, "tokenLeak") && TOKEN_RE.test(text)) {
    await act(m, "tokenLeak", "Discordトークンらしき文字列の投稿");
    return true;
  }
  if (isOn(g, "crash") && CRASH_RE.test(text)) {
    await act(m, "crash", "クライアントを重くする文字列の投稿");
    return true;
  }

  const linkOk = s.linkAllowed.includes(m.channelId);
  if (!linkOk && isOn(g, "invite") && hasInvite(text)) {
    await act(m, "invite", "招待リンクの投稿");
    return true;
  }

  const urls = [...text.matchAll(URL_RE)].map((x) => x[0]).slice(0, 5);
  if (!linkOk && isOn(g, "shortLink")) {
    for (const u of urls) {
      if (await resolvesToInvite(u)) {
        await act(m, "shortLink", "短縮URL経由の招待リンク");
        return true;
      }
    }
  }
  if (s.anti.scamLinkBlock && scamDomains.size) {
    for (const u of urls) {
      let host = "";
      try {
        host = new URL(u).hostname;
      } catch {
        continue;
      }
      if (isScamHost(host)) {
        await act(m, "scam", "詐欺サイトへのリンク", { steps: [5, 30, 60], escKey: "scam", label: "詐欺リンクブロック" });
        return true;
      }
    }
  }

  const lower = text.toLowerCase();
  for (const w of s.words) {
    if (lower.includes(w.word.toLowerCase())) {
      await applyWord(m, w.word, w.action);
      return true;
    }
  }
  return false;
}

/** 権限・除外の判定 */
function isPrivileged(m: GMessage, member: GuildMember | null): boolean {
  if (isExempt(m.guild, m.author.id)) return true;
  const p = member?.permissions;
  return !!(p?.has(PermissionFlagsBits.Administrator) || p?.has(PermissionFlagsBits.ManageMessages));
}

// ===== sticky pin =====
const stickyTimers = new Map<string, NodeJS.Timeout>();
function scheduleSticky(m: GMessage) {
  const s = getSettings(m.guildId);
  const st = s.sticky[m.channelId];
  if (!st) return;
  clearTimeout(stickyTimers.get(m.channelId));
  stickyTimers.set(
    m.channelId,
    setTimeout(async () => {
      const ch = m.channel;
      if (!("send" in ch)) return;
      if (st.lastId) await ch.messages.delete(st.lastId).catch(() => {});
      const sent = await ch.send(`📌 ${st.text}`).catch(() => null);
      if (sent) {
        st.lastId = sent.id;
        save();
      }
    }, 2000),
  );
}

// ===== 宣伝リミット =====
async function promoLimit(m: GMessage) {
  const s = getSettings(m.guildId);
  const hash = createHash("sha1").update(m.content.trim().toLowerCase()).digest("hex").slice(0, 16);
  const k = `${m.channelId}:${m.author.id}:${hash}`;
  const now = Date.now();
  const cur = s.promoLog[k];
  const rec = cur && now - cur.t < 7 * 86_400_000 ? { c: cur.c + 1, t: cur.t } : { c: 1, t: now };
  s.promoLog[k] = rec;
  for (const [kk, v] of Object.entries(s.promoLog)) if (now - v.t > 7 * 86_400_000) delete s.promoLog[kk];
  save();
  if (rec.c < 2) return;
  const deleted = rec.c >= 3;
  if (deleted) await del([m]);
  if ("send" in m.channel) {
    const w = await m.channel
      .send(`${m.author} 同じ宣伝は1週間に1回までです。${deleted ? "(3回目なのでメッセージを削除しました)" : "(次回は削除します)"}`)
      .catch(() => null);
    if (w) setTimeout(() => void w.delete().catch(() => {}), 15_000).unref();
  }
  await sendLog(
    m.guild,
    "📣 宣伝リミット",
    `**ユーザー**: <@${m.author.id}>\n**回数**: ${rec.c}回目 / **処置**: ${deleted ? "削除+警告" : "警告"}\n**チャンネル**: <#${m.channelId}>`,
    0xe67e22,
    "punish",
  );
}

// ===== 外部アプリ(サーバー未導入のアプリ)の連投 =====
async function onAppMessage(m: GMessage) {
  const g = m.guild.id;
  if (!isOn(g, "appSpam")) return;
  const meta = (m as any).interactionMetadata ?? (m as any).interaction;
  const invoker: string | undefined = meta?.user?.id;
  if (!invoker) return;
  if (m.guild.members.cache.has(m.author.id)) return; // サーバーに導入済みのBotは対象外
  const c = cfg(g, "appSpam");
  const n = hit(`app:${g}:${invoker}`, c.window * 1000);
  if (n < c.threshold) return;
  if (isExempt(m.guild, invoker)) return;
  const member = await m.guild.members.fetch(invoker).catch(() => null);
  if (member?.permissions.has(PermissionFlagsBits.Administrator)) return;
  await del([m]);
  const ok = await timeoutMember(m.guild, invoker, c.duration, "外部アプリの連投");
  await sendLog(
    m.guild,
    "🛡️ 外部アプリ連投",
    `**ユーザー**: <@${invoker}>\n**アプリ**: ${m.author.tag}\n**処置**: メッセージ削除 / ${ok ? `${fmt(c.duration)}タイムアウト` : "タイムアウト失敗"}`,
    0xe74c3c,
    "punish",
  );
}

// ===== メイン =====
async function onMessage(client: Client, m: Message) {
  if (!m.inGuild()) return;
  if (m.author.bot) {
    await onAppMessage(m);
    return;
  }
  const guild = m.guild;
  const g = guild.id;
  const s = getSettings(g);
  const member = m.member ?? (await guild.members.fetch(m.author.id).catch(() => null));
  const privileged = isPrivileged(m, member);
  const isAdmin = !!member?.permissions.has(PermissionFlagsBits.Administrator);

  // コマンド専用チャンネル
  if (s.notSpeak.includes(m.channelId) && !isAdmin) {
    await del([m]);
    return;
  }

  let removed = false;
  if (!privileged && !s.excluded.includes(m.channelId)) removed = await runDetections(m);

  if (!removed) {
    if (s.promoChannels.includes(m.channelId) && !isAdmin && m.content) await promoLimit(m);
    if (m.channelId === s.introChannelId && isOn(g, "introDup")) {
      const prev = await m.channel.messages.fetch({ limit: 100 }).catch(() => null);
      const mine = prev?.filter((x) => x.author.id === m.author.id && x.id !== m.id);
      if (mine?.size) {
        markBotDeleted([...mine.keys()]);
        await Promise.allSettled([...mine.values()].map((x) => x.delete()));
      }
    }
    if (s.sticky[m.channelId] && m.author.id !== client.user?.id) scheduleSticky(m);
  }
}

async function runDetections(m: GMessage): Promise<boolean> {
  const guild = m.guild;
  const g = guild.id;
  const s = getSettings(g);
  const member = m.member;
  const text = m.content;

  if (await contentRules(m)) return true;

  // @everyone / @here の無断使用
  if (isOn(g, "everyone") && /@(everyone|here)\b/.test(text) && !member?.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    await act(m, "everyone", "@everyone/@here の無断使用");
    return true;
  }
  if (isOn(g, "longMessage") && text.length > cfg(g, "longMessage").count) {
    await act(m, "longMessage", `長文メッセージ(${text.length}文字)`);
    return true;
  }

  // 大量メンション(1メッセージ)
  const mentions = m.mentions.users.size + m.mentions.roles.size;
  if (isOn(g, "massMention") && mentions >= cfg(g, "massMention").threshold) {
    await act(m, "massMention", `${mentions}件の大量メンション`);
    return true;
  }

  // ユーザーごとのレート制限
  const rl = s.rateLimits[m.author.id];
  if (rl && hit(`rl:${g}:${m.author.id}`, rl.windowMin * 60_000) > rl.max) {
    await act(m, "rateLimit", `レート制限超過(${rl.windowMin}分で${rl.max}件まで)`, { minutes: rl.durMin, label: "レート制限" });
    return true;
  }

  const recs = pushRecent(m);
  const within = (sec: number) => recs.filter((r) => Date.now() - r.at <= sec * 1000);

  // 連投系(レイドモード中はしきい値を半分に)
  if (isOn(g, "messageSpam")) {
    const c = cfg(g, "messageSpam");
    const th = inRaid(g) ? Math.max(2, Math.ceil(c.threshold / 2)) : c.threshold;
    const hits = within(c.window);
    if (hits.length >= th) {
      recent.delete(key(m));
      await act(m, "messageSpam", `${c.window}秒以内に${hits.length}件のメッセージ`, { del: hits.map((r) => r.msg) });
      return true;
    }
  }
  if (isOn(g, "duplicate") && text) {
    const c = cfg(g, "duplicate");
    const same = within(c.window).filter((r) => r.content === text);
    if (same.length >= c.threshold) {
      recent.delete(key(m));
      await act(m, "duplicate", `同じ内容を${same.length}回投稿`, { del: same.map((r) => r.msg) });
      return true;
    }
  }
  if (isOn(g, "mentionSpam")) {
    const c = cfg(g, "mentionSpam");
    const ms = within(c.window).filter((r) => r.mention);
    if (ms.length >= c.threshold) {
      recent.delete(key(m));
      await act(m, "mentionSpam", `${c.window}秒以内にメンション付き投稿が${ms.length}件`, { del: ms.map((r) => r.msg) });
      return true;
    }
  }
  if (isOn(g, "helpSpam") && /^!help\b/i.test(text.trim())) {
    const c = cfg(g, "helpSpam");
    if (hit(`help:${g}:${m.author.id}`, c.window * 1000) >= c.threshold) {
      await act(m, "helpSpam", `!help を${c.window}秒以内に${c.threshold}回`);
      return true;
    }
  }
  if (isOn(g, "pollSpam") && m.poll) {
    const c = cfg(g, "pollSpam");
    if (hit(`poll:${g}:${m.author.id}`, c.window * 1000) >= c.threshold) {
      await act(m, "pollSpam", `投票を${c.window}秒以内に${c.threshold}回作成`);
      return true;
    }
  }

  // 画像の拡散
  const imgs = [...m.attachments.values()].filter((a) => a.contentType?.startsWith("image/"));
  if (imgs.length && (isOn(g, "imageCross") || isOn(g, "imageSame"))) {
    const now = Date.now();
    const list = (images.get(key(m)) ?? []).filter((x) => now - x.at < 600_000);
    let hash: string | undefined;
    if (isOn(g, "imageSame") && imgs[0].size <= 8 * 1024 * 1024) {
      hash = await hashFromUrl(imgs[0].url).catch(() => undefined);
    }
    list.push({ at: now, msg: m, channelId: m.channelId, hash });
    images.set(key(m), list);

    if (isOn(g, "imageCross")) {
      const c = cfg(g, "imageCross");
      const w = list.filter((x) => now - x.at <= c.window * 1000);
      if (new Set(w.map((x) => x.channelId)).size >= c.threshold) {
        images.delete(key(m));
        await act(m, "imageCross", `${c.window}秒以内に${new Set(w.map((x) => x.channelId)).size}チャンネルへ画像を投稿`, { del: w.map((x) => x.msg) });
        return true;
      }
    }
    if (hash && isOn(g, "imageSame")) {
      const c = cfg(g, "imageSame");
      const w = list.filter((x) => now - x.at <= c.window * 1000 && x.hash && findSimilar([x.hash], hash!));
      if (new Set(w.map((x) => x.channelId)).size >= c.threshold) {
        images.delete(key(m));
        await act(m, "imageSame", `同じ画像を${new Set(w.map((x) => x.channelId)).size}チャンネルに拡散`, { del: w.map((x) => x.msg) });
        return true;
      }
    }
  }
  return false;
}

/** 埋め込み(リンクプレビュー)は後から付くので、編集イベントで検査する */
async function onUpdate(oldM: Message | any, newM: Message | any) {
  let m = newM as Message;
  if (m.partial) m = await m.fetch().catch(() => m);
  if (!m.inGuild() || m.author?.bot) return;
  const member = m.member ?? (await m.guild.members.fetch(m.author.id).catch(() => null));
  if (isPrivileged(m, member)) return;
  const s = getSettings(m.guildId);
  if (s.excluded.includes(m.channelId)) return;

  const embedText = m.embeds
    .map((e) => [e.url, e.title, e.description, e.author?.name, e.footer?.text].filter(Boolean).join(" "))
    .join("\n");
  const previewOn = isOn(m.guildId, "linkPreview");
  if (m.content !== oldM?.content || (previewOn && embedText)) {
    if (await contentRules(m, previewOn ? embedText : "")) return;
    // プレビューのURLが短縮リンク経由の招待でないか
    if (previewOn && isOn(m.guildId, "shortLink") && !s.linkAllowed.includes(m.channelId)) {
      for (const e of m.embeds) {
        if (e.url && (await resolvesToInvite(e.url))) {
          await act(m, "linkPreview", "リンクプレビューが招待リンクに転送される", { steps: [5, 30, 60], escKey: "shortLink" });
          return;
        }
      }
    }
  }
}

export function registerMessageGuard(client: Client) {
  client.on(Events.MessageCreate, (m) => void onMessage(client, m).catch((e) => console.error("messageguard:", e)));
  client.on(Events.MessageUpdate, (o, n) => void onUpdate(o, n).catch((e) => console.error("messageguard update:", e)));

  void loadScamList();
  setInterval(() => void loadScamList(), 6 * 3600_000).unref();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of recent) {
      const fresh = arr.filter((r) => now - r.at < 120_000);
      if (fresh.length) recent.set(k, fresh);
      else recent.delete(k);
    }
    for (const [k, arr] of images) {
      const fresh = arr.filter((r) => now - r.at < 600_000);
      if (fresh.length) images.set(k, fresh);
      else images.delete(k);
    }
  }, 60_000).unref();
}
