import { AuditLogEvent, Events, type Client, type Guild, type GuildMember, type Message } from "discord.js";
import { getSettings } from "./store.js";
import { cfg, isOn, timeoutMember } from "./detect.js";
import { sendLog } from "./log.js";
import { findAudit, hit, markBotDeleted } from "./util.js";
import { hasInvite, resolvesToInvite } from "./messageguard.js";
import { autoRestore } from "./rollback.js";

/** BANして、失敗したらキックする */
export async function banBot(guild: Guild, member: GuildMember, reason: string) {
  let result = "BAN";
  const banned = await guild.members.ban(member.id, { reason: `BOT荒らし対策: ${reason}` }).then(() => true).catch(() => false);
  if (!banned) {
    const kicked = await member.kick(`BOT荒らし対策: ${reason}`).then(() => true).catch(() => false);
    result = kicked ? "BANに失敗したのでキック" : "BAN/キックとも失敗(権限/順位を確認)";
  }
  await sendLog(
    guild,
    "🤖 BOT荒らし対策",
    `**BOT**: <@${member.id}> (${member.user.tag})\n**理由**: ${reason}\n**処置**: ${result}`,
    0xc0392b,
    "punish",
  );
  autoRestore(guild);
}

export function registerBotGuard(client: Client) {
  // ===== 監査ログを使う検知(BOTが実行者のときだけ) =====
  const audit = async (guild: Guild, type: AuditLogEvent, targetId: string, detKey: string, label: string) => {
    if (!isOn(guild.id, detKey)) return;
    const entry = await findAudit(guild, type, targetId);
    const id = entry?.executorId;
    if (!id || id === client.user?.id) return;
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member?.user.bot) return;
    if (getSettings(guild.id).botGuard.exceptions.includes(id)) return;
    const c = cfg(guild.id, detKey);
    const n = hit(`botg:${detKey}:${guild.id}:${id}`, c.window * 1000);
    if (n < c.threshold) return;
    await banBot(guild, member, `${label}を${c.window}秒以内に${n}回`);
  };

  client.on(Events.ChannelDelete, (ch) => {
    if ("guild" in ch && ch.guild) void audit(ch.guild, AuditLogEvent.ChannelDelete, ch.id, "botChannelDelete", "チャンネル削除");
  });
  client.on(Events.ChannelCreate, (ch) => {
    void audit(ch.guild, AuditLogEvent.ChannelCreate, ch.id, "botChannelCreate", "チャンネル作成");
  });
  client.on(Events.GuildRoleDelete, (role) => {
    void audit(role.guild, AuditLogEvent.RoleDelete, role.id, "botRoleDelete", "ロール削除");
  });
  client.on(Events.GuildBanAdd, (ban) => {
    void audit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, "botMassBan", "BAN");
  });

  // ===== BOT/Webhookのメッセージ =====
  const recs = new Map<string, { at: number; msg: Message<true>; everyone: boolean }[]>();

  client.on(Events.MessageCreate, async (m) => {
    try {
      if (!m.inGuild() || !m.author.bot || m.author.id === client.user?.id) return;
      const guild = m.guild;
      const g = guild.id;
      const s = getSettings(g);
      if (!s.botGuard.enabled) return;
      if (s.excluded.includes(m.channelId)) return;
      const meta = (m as any).interactionMetadata ?? (m as any).interaction;

      // --- Webhook連投: Webhookを削除する ---
      if (m.webhookId) {
        if (meta || !isOn(g, "webhookSpam") || s.webhookExcluded.includes(m.channelId)) return;
        const c = cfg(g, "webhookSpam");
        if (hit(`wh:${m.webhookId}`, c.window * 1000) < c.threshold) return;
        const hooks = await guild.fetchWebhooks().catch(() => null);
        const hook = hooks?.get(m.webhookId);
        if (!hook) return; // サーバーのWebhookではない(外部アプリ等)
        const ok = await hook.delete("Webhook連投").then(() => true).catch(() => false);
        markBotDeleted([m.id]);
        await m.delete().catch(() => {});
        await sendLog(
          guild,
          "🪝 Webhook連投",
          `**Webhook**: ${hook.name} (\`${hook.id}\`)\n**チャンネル**: <#${m.channelId}>\n**条件**: ${c.window}秒以内に${c.threshold}件\n**処置**: ${ok ? "Webhookを削除" : "削除失敗(権限を確認)"}`,
          0xe74c3c,
          "punish",
        );
        return;
      }

      // --- ここからはサーバーに入っているBOT ---
      const member = m.member ?? (await guild.members.fetch(m.author.id).catch(() => null));
      if (!member || s.botGuard.exceptions.includes(m.author.id)) return;

      // 招待リンク・短縮URL・NGワードの送信を防ぐ
      if (s.botGuard.inviteBlock && m.content) {
        const lower = m.content.toLowerCase();
        let bad = !s.linkAllowed.includes(m.channelId) && hasInvite(m.content);
        if (!bad && !s.linkAllowed.includes(m.channelId)) {
          for (const u of (m.content.match(/https?:\/\/[^\s<>()]+/gi) ?? []).slice(0, 3)) {
            if (await resolvesToInvite(u)) {
              bad = true;
              break;
            }
          }
        }
        const ng = s.words.find((w) => lower.includes(w.word.toLowerCase()));
        if (bad || ng) {
          markBotDeleted([m.id]);
          await m.delete().catch(() => {});
          await sendLog(
            guild,
            "🤖 BOTの不適切な送信を削除",
            `**BOT**: <@${m.author.id}>\n**内容**: ${bad ? "招待リンク/短縮URL" : "NGワード"}\n**チャンネル**: <#${m.channelId}>`,
            0xe67e22,
            "punish",
          );
          return;
        }
      }

      // @everyone を使ったBOTは即BAN
      if (isOn(g, "botEveryone") && m.mentions.everyone) {
        markBotDeleted([m.id]);
        await m.delete().catch(() => {});
        await banBot(guild, member, "BOTが @everyone/@here を使用");
        return;
      }

      // BOTのメッセージ連投
      if (isOn(g, "botMsgSpam")) {
        const c = cfg(g, "botMsgSpam");
        const k = `${g}:${m.author.id}`;
        const now = Date.now();
        const arr = (recs.get(k) ?? []).filter((r) => now - r.at <= c.window * 1000);
        arr.push({ at: now, msg: m, everyone: m.mentions.everyone });
        recs.set(k, arr);
        if (arr.length >= c.threshold) {
          recs.delete(k);
          markBotDeleted(arr.map((r) => r.msg.id));
          await Promise.allSettled(arr.map((r) => r.msg.delete()));
          if (arr.some((r) => r.everyone)) {
            await banBot(guild, member, `${c.window}秒以内に${arr.length}件の連投(@everyone付き)`);
          } else {
            const ok = await timeoutMember(guild, m.author.id, c.duration, "BOTのメッセージ連投");
            await sendLog(
              guild,
              "🤖 BOTのメッセージ連投",
              `**BOT**: <@${m.author.id}>\n**条件**: ${c.window}秒以内に${arr.length}件\n**処置**: メッセージ削除 / ${ok ? `${c.duration}分タイムアウト` : "タイムアウト失敗"}`,
              0xe74c3c,
              "punish",
            );
          }
        }
      }
    } catch (e) {
      console.error("botguard:", e);
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of recs) {
      const fresh = arr.filter((r) => now - r.at < 120_000);
      if (fresh.length) recs.set(k, fresh);
      else recs.delete(k);
    }
  }, 60_000).unref();
}
