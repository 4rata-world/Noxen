import {
  ChannelType,
  EmbedBuilder,
  Events,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import { DEFS, isOn } from "./detect.js";
import { getSettings, save, type LogType } from "./store.js";
import { sendLog } from "./log.js";

export const LOG_LABELS: Record<LogType, string> = {
  join: "参加退出ログ",
  message: "メッセージログ",
  admin: "管理ログ",
  punish: "処罰ログ",
  vc: "VCログ",
};

// ===== /allsetup =====
export async function runAllSetup(guild: Guild, mode: "full" | "min"): Promise<string[]> {
  const s = getSettings(guild.id);
  const me = guild.members.me;
  const lines: string[] = [];

  // 管理者だけが見えるカテゴリ
  let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === "管理ログ");
  if (!category) {
    category = await guild.channels.create({
      name: "管理ログ",
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        ...(me
          ? [{
              id: me.id,
              type: OverwriteType.Member,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
            }]
          : []),
      ],
      reason: "/allsetup",
    });
    lines.push("📁 カテゴリ「管理ログ」を作成");
  } else {
    lines.push("📁 カテゴリ「管理ログ」は既存のものを使用");
  }

  const ensure = async (name: string, parentId: string | null): Promise<TextChannel> => {
    const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
    if (found) {
      lines.push(`♻️ #${name} は既存のものを使用`);
      return found as TextChannel;
    }
    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId ?? undefined,
      reason: "/allsetup",
    });
    lines.push(`✅ #${name} を作成`);
    return ch;
  };

  for (const t of Object.keys(LOG_LABELS) as LogType[]) {
    if (mode === "min" && (t === "punish" || t === "join")) {
      // 最低限: 参加退出/処罰ログは作らない
      continue;
    }
    s.logChannels[t] = (await ensure(LOG_LABELS[t], category.id)).id;
  }
  s.reportChannelId = (await ensure("通報", category.id)).id;

  if (mode === "full") {
    s.logChannels.join = (await ensure(LOG_LABELS.join, category.id)).id;
    s.logChannels.punish = (await ensure(LOG_LABELS.punish, category.id)).id;
    s.joinNoticeChannelId = (await ensure("参加通知", null)).id;
  }
  save();
  return lines;
}

// ===== /viewsettings =====
const ch = (id?: string) => (id ? `<#${id}>` : "未設定");
const onoff = (b: boolean) => (b ? "✅ ON" : "❌ OFF");

export function describeSettings(guild: Guild): EmbedBuilder {
  const s = getSettings(guild.id);
  const g = guild.id;
  const list = (ids: string[]) => (ids.length ? ids.map((x) => `<#${x}>`).join(" ") : "なし");
  const userOn = DEFS.filter((d) => d.group === "user" && isOn(g, d.key)).length;
  const userAll = DEFS.filter((d) => d.group === "user").length;
  const botOn = DEFS.filter((d) => d.group === "bot" && isOn(g, d.key)).length;
  const botAll = DEFS.filter((d) => d.group === "bot").length;

  return new EmbedBuilder()
    .setTitle(`⚙️ 設定一覧: ${guild.name}`)
    .setColor(0x5865f2)
    .addFields(
      {
        name: "ログ",
        value: [
          ...(Object.keys(LOG_LABELS) as LogType[]).map((t) => `${LOG_LABELS[t]}: ${ch(s.logChannels[t])}`),
          `共通の送信先(/auditlog_channel): ${ch(s.logChannelId)}`,
          `再起動ログ: ${onoff(s.restartLog)}`,
        ].join("\n"),
      },
      {
        name: "チャンネル",
        value: [
          `参加通知: ${ch(s.joinNoticeChannelId)}`,
          `招待リンクログ: ${{ join: "参加退出ログ", notice: "参加通知", off: "無効" }[s.inviteLogDest]}`,
          `自己紹介: ${ch(s.introChannelId)}`,
          `通報: ${ch(s.reportChannelId)}`,
        ].join("\n"),
      },
      {
        name: "荒らし対策",
        value:
          `ユーザー: ${onoff(s.anti.enabled)} (検知 ${userOn}/${userAll}件ON)\n` +
          `BOT: ${onoff(s.botGuard.enabled)} (検知 ${botOn}/${botAll}件ON)\n` +
          `短縮リンクブロック: ${onoff(s.anti.shortLinkBlock)} / 詐欺リンクブロック: ${onoff(s.anti.scamLinkBlock)}\n` +
          `BOT招待リンクブロック: ${onoff(s.botGuard.inviteBlock)} / Webhook連投: ${onoff(s.botGuard.webhookSpam)}\n` +
          `BOT例外: ${s.botGuard.exceptions.length}件`,
      },
      {
        name: "モデレーション",
        value: [
          `NGワード: ${s.words.length}件 / レート制限: ${Object.keys(s.rateLimits).length}人`,
          `コマンド専用: ${list(s.notSpeak)}`,
          `招待リンク許可: ${list(s.linkAllowed)}`,
          `除外チャンネル: ${list(s.excluded)}`,
          `Webhook検知の除外: ${list(s.webhookExcluded)}`,
          `宣伝リミット: ${list(s.promoChannels)}`,
          `sticky pin: ${list(Object.keys(s.sticky))}`,
          `DMブロック: ${onoff(s.dmBlock)}`,
        ].join("\n"),
      },
      {
        name: "サーバー保護",
        value:
          `AntiNuke: ${onoff(s.antinuke.enabled)} (${s.antinuke.windowSec}秒で${s.antinuke.limit}回 / ${s.antinuke.alertMode})\n` +
          `InviteSafeMode: ${onoff(s.inviteSafe.enabled)}\n` +
          `Guard(参加者チェック): ${onoff(s.guard.enabled)}\n` +
          `ブラックリストID: ${s.blacklist.length}件 / ホワイトリスト: ${s.whitelist.length}人 / 画像: ${s.imageHashes.length}枚\n` +
          `自動ロールバック: ${onoff(s.rollback.autoRestore)}`,
      },
    );
}

// ===== DMブロック(サーバー設定のセキュリティ操作) =====
export async function applyDmBlock(guild: Guild, on: boolean): Promise<boolean> {
  const inv = (guild as any).incidentsData?.invitesDisabledUntil;
  const invIso = inv ? new Date(inv).toISOString() : null;
  // 上限は24時間なので、ONの間は定期的に更新する
  const until = on ? new Date(Date.now() + 24 * 3600_000 - 60_000).toISOString() : null;
  return guild.client.rest
    .put(`/guilds/${guild.id}/incident-actions`, {
      body: { invites_disabled_until: invIso, dms_disabled_until: until },
    })
    .then(() => true)
    .catch(() => false);
}

// ===== 参加/退出ログ・招待リンクログ・参加通知・再起動ログ =====
const inviteCache = new Map<string, Map<string, number>>();

async function cacheInvites(guild: Guild) {
  const invs = await guild.invites.fetch().catch(() => null);
  if (invs) inviteCache.set(guild.id, new Map(invs.map((i) => [i.code, i.uses ?? 0])));
}

export function registerSetup(client: Client) {
  client.once(Events.ClientReady, async (c) => {
    for (const g of c.guilds.cache.values()) {
      await cacheInvites(g);
      if (getSettings(g.id).restartLog) await sendLog(g, "🔄 Botが再起動しました", `<t:${Math.floor(Date.now() / 1000)}:f>`, 0x3498db);
    }
  });
  client.on(Events.GuildCreate, (g) => void cacheInvites(g));
  client.on(Events.InviteCreate, (inv) => {
    if (inv.guild && "id" in inv.guild) {
      const m = inviteCache.get(inv.guild.id) ?? new Map();
      m.set(inv.code, inv.uses ?? 0);
      inviteCache.set(inv.guild.id, m);
    }
  });
  client.on(Events.InviteDelete, (inv) => {
    if (inv.guild && "id" in inv.guild) inviteCache.get(inv.guild.id)?.delete(inv.code);
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const guild = member.guild;
    const s = getSettings(guild.id);

    // どの招待リンクで入ったか(使用回数が増えたもの)
    let inviteInfo = "";
    if (s.inviteLogDest !== "off") {
      const before = inviteCache.get(guild.id) ?? new Map<string, number>();
      const now = await guild.invites.fetch().catch(() => null);
      if (now) {
        const used = now.find((i) => (i.uses ?? 0) > (before.get(i.code) ?? 0));
        inviteCache.set(guild.id, new Map(now.map((i) => [i.code, i.uses ?? 0])));
        inviteInfo = used
          ? `招待: \`${used.code}\` (作成者: ${used.inviter ? `<@${used.inviter.id}>` : "不明"} / 使用${used.uses}回)`
          : "招待: 特定できませんでした(Vanity URLや期限切れの招待の可能性)";
      } else {
        inviteInfo = "招待: 取得できませんでした(「サーバー管理」権限が必要です)";
      }
    }

    const ageDays = ((Date.now() - member.user.createdTimestamp) / 86_400_000).toFixed(1);
    await sendLog(
      guild,
      member.user.bot ? "🤖 Bot参加" : "📥 メンバー参加",
      `<@${member.id}> (${member.user.tag})\nアカウント作成: <t:${Math.floor(member.user.createdTimestamp / 1000)}:R> (${ageDays}日前)` +
        (s.inviteLogDest === "join" && inviteInfo ? `\n${inviteInfo}` : ""),
      0x2ecc71,
      "join",
    );

    if (s.joinNoticeChannelId && !member.user.bot) {
      const notice = await guild.channels.fetch(s.joinNoticeChannelId).catch(() => null);
      if (notice?.isTextBased()) {
        await notice
          .send(`👋 <@${member.id}> さん、ようこそ **${guild.name}** へ!` + (s.inviteLogDest === "notice" && inviteInfo ? `\n-# ${inviteInfo}` : ""))
          .catch(() => {});
      }
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await sendLog(
      member.guild,
      "📤 メンバー退出",
      `<@${member.id}> (${member.user.tag})` +
        (member.joinedTimestamp ? `\n参加: <t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : ""),
      0x95a5a6,
      "join",
    );
  });

  // DMブロックを維持する(上限24時間なので12時間ごとに更新)
  setInterval(() => {
    for (const g of client.guilds.cache.values()) {
      if (getSettings(g.id).dmBlock) void applyDmBlock(g, true);
    }
  }, 12 * 3600_000).unref();

}
