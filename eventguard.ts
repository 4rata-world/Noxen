import {
  Events,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
} from "discord.js";
import { cfg, isOn, noteFlagged, timeoutMember } from "./detect.js";
import { sendLog } from "./log.js";
import { hit, isExempt } from "./util.js";

const fmt = (min: number) =>
  min >= 1440 ? `${Math.round(min / 144) / 10}日` : min >= 60 ? `${Math.round(min / 6) / 10}時間` : `${min}分`;

/** 権限を持つ人・ホワイトリストは検知しない */
async function skipUser(guild: Guild, userId: string): Promise<GuildMember | null> {
  if (isExempt(guild, userId)) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return null;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return null;
  return member;
}

export function registerEventGuard(client: Client) {
  // ===== VC入退室の連投 + VCログ =====
  client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
    const guild = newS.guild;
    const userId = newS.id;
    const tag = `<@${userId}>`;

    if (oldS.channelId !== newS.channelId) {
      if (!oldS.channelId && newS.channelId) {
        await sendLog(guild, "🔊 VC参加", `${tag} → <#${newS.channelId}>`, 0x2ecc71, "vc");
      } else if (oldS.channelId && !newS.channelId) {
        await sendLog(guild, "🔇 VC退出", `${tag} ← <#${oldS.channelId}>`, 0x95a5a6, "vc");
      } else {
        await sendLog(guild, "🔀 VC移動", `${tag}: <#${oldS.channelId}> → <#${newS.channelId}>`, 0x3498db, "vc");
      }
    }

    // 参加(移動を含む)が短時間に繰り返されたら処罰
    if (!newS.channelId || oldS.channelId === newS.channelId) return;
    if (!isOn(guild.id, "vcSpam")) return;
    const c = cfg(guild.id, "vcSpam");
    if (hit(`vc:${guild.id}:${userId}`, c.window * 1000) < c.threshold) return;
    const member = await skipUser(guild, userId);
    if (!member) return;
    await member.voice.disconnect("VC入退室の連投").catch(() => {});
    const ok = await timeoutMember(guild, userId, c.duration, "VC入退室の連投");
    await sendLog(
      guild,
      "🛡️ VC入退室連投",
      `**ユーザー**: <@${userId}>\n**条件**: ${c.window}秒以内に${c.threshold}回の参加\n**処置**: VC切断 / ${ok ? `${fmt(c.duration)}タイムアウト` : "タイムアウト失敗"}`,
      0xe74c3c,
      "punish",
    );
    void noteFlagged(guild, userId);
  });

  // ===== リアクション連投 =====
  // user -> messageId -> { 自分が付けたリアクション数 }
  const reactTrack = new Map<string, Map<string, { n: number; at: number; channelId: string }>>();
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot) return;
      const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => null) : reaction.message;
      const guild = msg?.guild;
      if (!msg || !guild) return;
      if (!isOn(guild.id, "reactionSpam")) return;

      const c = cfg(guild.id, "reactionSpam");
      const k = `${guild.id}:${user.id}`;
      const now = Date.now();
      const map = reactTrack.get(k) ?? new Map();
      for (const [id, v] of map) if (now - v.at > c.window * 1000) map.delete(id);
      const cur = map.get(msg.id) ?? { n: 0, at: now, channelId: msg.channelId };
      cur.n++;
      map.set(msg.id, cur);
      reactTrack.set(k, map);

      const flagged = [...map.entries()].filter(([, v]) => v.n >= c.count);
      if (flagged.length < c.threshold) return;
      const member = await skipUser(guild, user.id);
      if (!member) return;

      reactTrack.delete(k);
      // その人が付けたリアクションを外す
      for (const [id, v] of flagged) {
        const ch = await guild.channels.fetch(v.channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) continue;
        const target = await ch.messages.fetch(id).catch(() => null);
        if (!target) continue;
        await Promise.allSettled(target.reactions.cache.map((r) => r.users.remove(user.id)));
      }
      const ok = await timeoutMember(guild, user.id, c.duration, "リアクション連投");
      await sendLog(
        guild,
        "🛡️ リアクション連投",
        `**ユーザー**: <@${user.id}>\n**条件**: ${Math.round(c.window / 60)}分以内に、${c.count}個以上のリアクションを${flagged.length}メッセージへ\n` +
          `**処置**: リアクション削除 / ${ok ? `${fmt(c.duration)}タイムアウト` : "タイムアウト失敗"}`,
        0xe74c3c,
        "punish",
      );
      void noteFlagged(guild, user.id);
    } catch (e) {
      console.error("reactionSpam:", e);
    }
  });

  // ===== スレッド連投 =====
  const threads = new Map<string, { id: string; at: number }[]>();
  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    if (!newlyCreated || !thread.guild || !thread.ownerId) return;
    const guild = thread.guild;
    if (!isOn(guild.id, "threadSpam")) return;
    const c = cfg(guild.id, "threadSpam");
    const k = `${guild.id}:${thread.ownerId}`;
    const now = Date.now();
    const list = (threads.get(k) ?? []).filter((t) => now - t.at < 600_000);
    list.push({ id: thread.id, at: now });
    threads.set(k, list);
    if (list.filter((t) => now - t.at <= c.window * 1000).length < c.threshold) return;

    const member = await skipUser(guild, thread.ownerId);
    if (!member) return;
    threads.delete(k);
    for (const t of list) {
      const th = await guild.channels.fetch(t.id).catch(() => null);
      if (th) await th.delete("スレッド連投").catch(() => {});
    }
    const ok = await timeoutMember(guild, thread.ownerId, c.duration, "スレッド連投");
    await sendLog(
      guild,
      "🛡️ スレッド連投",
      `**ユーザー**: <@${thread.ownerId}>\n**条件**: ${c.window}秒以内に${c.threshold}個\n**処置**: 直近10分のスレッド${list.length}個を削除 / ${ok ? `${fmt(c.duration)}タイムアウト` : "タイムアウト失敗"}`,
      0xe74c3c,
      "punish",
    );
    void noteFlagged(guild, thread.ownerId);
  });

  // ===== 大量参加(ログのみ) =====
  const warned = new Map<string, number>();
  client.on(Events.GuildMemberAdd, async (member) => {
    const guild = member.guild;
    if (!isOn(guild.id, "massJoin")) return;
    const c = cfg(guild.id, "massJoin");
    const n = hit(`massjoin:${guild.id}`, c.window * 1000);
    if (n < c.threshold) return;
    if (Date.now() - (warned.get(guild.id) ?? 0) < c.window * 1000) return;
    warned.set(guild.id, Date.now());
    await sendLog(
      guild,
      "⚠️ 大量参加を検知",
      `${c.window}秒以内に${n}人が参加しました。(ログのみで、処罰はしていません)`,
      0xe67e22,
      "join",
    );
  });

}
