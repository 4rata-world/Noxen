import { AuditLogEvent, Events, type Client, type Guild } from "discord.js";
import { sendLog } from "./log.js";
import { clip, findAudit, wasDeletedByBot } from "./util.js";

const seenAudit = new Set<string>();

const who = (id?: string | null) => (id ? `<@${id}>` : "不明");

export function registerAuditLog(client: Client) {
  client.on(Events.MessageDelete, async (m) => {
    if (!m.guild || wasDeletedByBot(m.id)) return;
    if (m.author?.id === client.user?.id) return;
    await sendLog(
      m.guild,
      "🗑️ メッセージ削除",
      `**投稿者**: ${who(m.author?.id)}\n**チャンネル**: <#${m.channelId}>\n**内容**: ${clip(m.content ?? "(キャッシュなし)")}`,
      0x95a5a6,
      "message",
    );
  });

  client.on(Events.MessageUpdate, async (oldM, newM) => {
    if (!newM.guild || newM.author?.bot) return;
    if (oldM.content === newM.content) return;
    await sendLog(
      newM.guild,
      "✏️ メッセージ編集",
      `**投稿者**: ${who(newM.author?.id)}\n**チャンネル**: <#${newM.channelId}> ([移動](${newM.url}))\n` +
        `**前**: ${clip(oldM.content ?? "(キャッシュなし)", 700)}\n**後**: ${clip(newM.content ?? "", 700)}`,
      0x3498db,
      "message",
    );
  });

  client.on(Events.MessageBulkDelete, async (msgs, channel) => {
    const manual = msgs.filter((m) => !wasDeletedByBot(m.id));
    if (manual.size === 0) return;
    await sendLog(
      channel.guild,
      "🧹 メッセージ一括削除",
      `**チャンネル**: <#${channel.id}>\n**件数**: ${manual.size}`,
      0x95a5a6,
      "message",
    );
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    const e = await findAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await sendLog(
      ban.guild,
      "🔨 BAN",
      `**対象**: <@${ban.user.id}> (${ban.user.tag})\n**実行者**: ${who(e?.executorId)}\n**理由**: ${clip(ban.reason ?? e?.reason ?? "")}`,
      0xc0392b,
      "punish",
    );
  });

  client.on(Events.GuildBanRemove, async (ban) => {
    const e = await findAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    await sendLog(ban.guild, "🕊️ BAN解除", `**対象**: <@${ban.user.id}> (${ban.user.tag})\n**実行者**: ${who(e?.executorId)}`, 0x2ecc71, "punish");
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    const e = await findAudit(member.guild, AuditLogEvent.MemberKick, member.id);
    if (!e) return; // 自主退出やBANは別ログ
    await sendLog(
      member.guild,
      "👢 キック",
      `**対象**: <@${member.id}> (${member.user.tag})\n**実行者**: ${who(e.executorId)}\n**理由**: ${clip(e.reason ?? "")}`,
      0xe67e22,
      "punish",
    );
  });

  client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
    const before = oldM.communicationDisabledUntilTimestamp;
    const after = newM.communicationDisabledUntilTimestamp;
    if (before === after) return;
    const e = await findAudit(newM.guild, AuditLogEvent.MemberUpdate, newM.id);
    if (e?.executorId === client.user?.id) return; // Bot自身の処罰は各モジュールのログで出る
    const active = after && after > Date.now();
    await sendLog(
      newM.guild,
      active ? "🔇 タイムアウト" : "🔈 タイムアウト解除",
      `**対象**: <@${newM.id}>\n**実行者**: ${who(e?.executorId)}` +
        (active ? `\n**解除予定**: <t:${Math.floor(after / 1000)}:R>\n**理由**: ${clip(e?.reason ?? "")}` : ""),
      active ? 0xe67e22 : 0x2ecc71,
      "punish",
    );
  });

  client.on(Events.WebhooksUpdate, async (channel) => {
    const guild: Guild = channel.guild;
    const types = [
      [AuditLogEvent.WebhookCreate, "🪝 Webhook作成"],
      [AuditLogEvent.WebhookUpdate, "🪝 Webhook編集"],
      [AuditLogEvent.WebhookDelete, "🪝 Webhook削除"],
    ] as const;
    for (const [type, title] of types) {
      const e = await findAudit(guild, type);
      if (!e || seenAudit.has(e.id)) continue;
      seenAudit.add(e.id);
      setTimeout(() => seenAudit.delete(e.id), 60_000).unref();
      await sendLog(guild, title, `**チャンネル**: <#${channel.id}>\n**実行者**: ${who(e.executorId)}`, 0x9b59b6);
    }
  });
}
