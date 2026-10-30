import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
} from "discord.js";
import { getSettings } from "./store.js";
import { sendLog } from "./log.js";
import { timeoutMember } from "./detect.js";
import { clip } from "./util.js";

export const reportContext = new ContextMenuCommandBuilder()
  .setName("通報")
  .setType(ApplicationCommandType.Message)
  .setDMPermission(false)
  .toJSON();

const ACTIONS: Record<string, { label: string; minutes?: number; style: ButtonStyle }> = {
  BAN: { label: "BAN", style: ButtonStyle.Danger },
  KICK: { label: "KICK", style: ButtonStyle.Danger },
  WARN: { label: "警告(DM)", style: ButtonStyle.Primary },
  T1H: { label: "タイムアウト1時間", minutes: 60, style: ButtonStyle.Secondary },
  T6H: { label: "6時間", minutes: 360, style: ButtonStyle.Secondary },
  T1D: { label: "1日", minutes: 1440, style: ButtonStyle.Secondary },
  T1W: { label: "1週間", minutes: 10080, style: ButtonStyle.Secondary },
  DISMISS: { label: "対応なし", style: ButtonStyle.Secondary },
};

const canHandle = (i: Interaction) =>
  !!(i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

/** 通報まわりのインタラクションを処理する。処理したら true */
export async function handleReport(i: Interaction): Promise<boolean> {
  // ===== メッセージを右クリック → アプリ → 通報 =====
  if (i.isMessageContextMenuCommand() && i.commandName === "通報") {
    if (!i.guild) return true;
    const s = getSettings(i.guild.id);
    const ch = s.reportChannelId ? await i.guild.channels.fetch(s.reportChannelId).catch(() => null) : null;
    if (!ch || !ch.isTextBased()) {
      await i.reply({ content: "通報の送信先が未設定です。管理者に `/set通報` を依頼してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const target = i.targetMessage;
    if (target.author.id === i.user.id) {
      await i.reply({ content: "自分のメッセージは通報できません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const embed = new EmbedBuilder()
      .setTitle("🚩 メッセージが通報されました")
      .setColor(0xe74c3c)
      .addFields(
        { name: "通報者", value: `<@${i.user.id}>`, inline: true },
        { name: "対象者", value: `<@${target.author.id}> (${target.author.tag})`, inline: true },
        { name: "チャンネル", value: `<#${target.channelId}> ([元のメッセージ](${target.url}))` },
        { name: "内容", value: clip(target.content || "(本文なし / 添付のみ)", 1000) },
      )
      .setTimestamp();
    const btn = (k: string) =>
      new ButtonBuilder().setCustomId(`rep|${k}|${target.author.id}`).setLabel(ACTIONS[k].label).setStyle(ACTIONS[k].style);
    await ch.send({
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(btn("BAN"), btn("KICK"), btn("WARN"), btn("DISMISS")),
        new ActionRowBuilder<ButtonBuilder>().addComponents(btn("T1H"), btn("T6H"), btn("T1D"), btn("T1W")),
      ],
    });
    await i.reply({ content: "通報しました。ご協力ありがとうございます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  // ===== 管理者が処罰ボタンを押した =====
  if (i.isButton() && i.customId.startsWith("rep|")) {
    if (!canHandle(i)) {
      await i.reply({ content: "管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const [, action, userId] = i.customId.split("|");
    if (action === "DISMISS") {
      await i.update({ components: [], content: `✅ 対応なし (${i.user.tag})` });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`repm|${action}|${userId}`)
      .setTitle(`${ACTIONS[action]?.label ?? action} を実行`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("extra")
            .setLabel("対象者へ送る追加メッセージ(任意)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500),
        ),
      );
    await i.showModal(modal);
    return true;
  }

  // ===== 追加メッセージを入力して実行 =====
  if (i.isModalSubmit() && i.customId.startsWith("repm|")) {
    if (!i.guild || !canHandle(i)) return true;
    const [, action, userId] = i.customId.split("|");
    const def = ACTIONS[action];
    if (!def) return true;
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const extra = i.fields.getTextInputValue("extra").trim();
    const user = await i.client.users.fetch(userId).catch(() => null);
    const reason = `通報による処分 (実行: ${i.user.tag})`;

    // DMで知らせる(拒否されていたら送れない)
    let dm = "未送信";
    if (user) {
      const text =
        `**${i.guild.name}** で、あなたのメッセージが通報され「${def.label}」の処分になりました。` +
        (extra ? `\n\n管理者からのメッセージ:\n${extra}` : "");
      dm = (await user.send(text).then(() => true).catch(() => false)) ? "送信済み" : "送信できず(DM拒否)";
    }

    let result = "";
    if (action === "BAN") {
      result = (await i.guild.members.ban(userId, { reason }).then(() => true).catch(() => false)) ? "BANしました" : "BANに失敗しました";
    } else if (action === "KICK") {
      const m = await i.guild.members.fetch(userId).catch(() => null);
      result = m && (await m.kick(reason).then(() => true).catch(() => false)) ? "キックしました" : "キックに失敗しました";
    } else if (def.minutes) {
      result = (await timeoutMember(i.guild, userId, def.minutes, reason)) ? `${def.label}を適用しました` : "タイムアウトに失敗しました";
    } else {
      result = "警告を送りました";
    }

    await sendLog(
      i.guild,
      "🚩 通報の処分",
      `**対象**: <@${userId}>\n**処分**: ${def.label}\n**実行**: <@${i.user.id}>\n**結果**: ${result}\n**DM**: ${dm}`,
      0xe74c3c,
      "punish",
    );
    // 元の通報メッセージのボタンを消す
    await (i as any).message?.edit({ components: [], content: `✅ ${def.label} 実行済み (${i.user.tag})` }).catch(() => {});
    await i.editReply(`${result}(DM: ${dm})`);
    return true;
  }

  return false;
}
