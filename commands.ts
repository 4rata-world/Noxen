import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import { getSettings, save } from "./store.js";
import { sendLog } from "./log.js";
import { markBotDeleted } from "./util.js";
import { findSimilar, hashFromUrl } from "./images.js";
import { lockInvites, unlockInvites } from "./invites.js";
import { scanWeakpoints } from "./weakpoint.js";
import { contextDefs, definitions2 } from "./commands2.js";

const ADMIN = PermissionFlagsBits.Administrator;
const MOD = PermissionFlagsBits.ManageMessages;

const onOff = (b: boolean) => (b ? "✅ ON" : "❌ OFF");

// ===== コマンド定義 =====
export const definitions = [
  new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("サーバー破壊対策の設定(オプションなしで現在の設定を表示)")
    .addBooleanOption((o) => o.setName("enabled").setDescription("有効/無効"))
    .addIntegerOption((o) => o.setName("limit").setDescription("この回数で処罰(既定3)").setMinValue(2).setMaxValue(20))
    .addIntegerOption((o) => o.setName("window_sec").setDescription("数える秒数(既定5)").setMinValue(1).setMaxValue(60))
    .addStringOption((o) =>
      o
        .setName("punishment")
        .setDescription("処罰の内容")
        .addChoices(
          { name: "危険な権限のロールを剥奪(strip)", value: "strip" },
          { name: "キック", value: "kick" },
          { name: "BAN", value: "ban" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("alert_mode")
        .setDescription("High=ホワイトリストの人も監視する")
        .addChoices({ name: "Normal", value: "normal" }, { name: "High", value: "high" }),
    )
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("invite_safemode")
    .setDescription("招待リンクの大量作成を検知したら、削除して作成を止める")
    .addBooleanOption((o) => o.setName("enabled").setDescription("有効/無効"))
    .addIntegerOption((o) => o.setName("limit").setDescription("この個数で発動(既定5)").setMinValue(2).setMaxValue(50))
    .addIntegerOption((o) => o.setName("window_sec").setDescription("数える秒数(既定30)").setMinValue(5).setMaxValue(600))
    .addBooleanOption((o) => o.setName("unlock").setDescription("true=ロック解除(招待作成権限を戻す)"))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("blacklist_add_image")
    .setDescription("画像をブラックリストに追加(似た画像も自動削除)")
    .addAttachmentOption((o) => o.setName("image").setDescription("登録する画像").setRequired(true))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("blacklist_remove_image")
    .setDescription("画像をブラックリストから外す")
    .addAttachmentOption((o) => o.setName("image").setDescription("外したい画像(登録時と同じもの)").setRequired(true))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("ユーザー/BotのIDブラックリスト(参加した瞬間にBAN)")
    .addSubcommand((s) =>
      s.setName("add").setDescription("IDを追加(参加済みなら即BAN)").addStringOption((o) => o.setName("id").setDescription("ユーザー/BotのID").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("remove").setDescription("IDを外す").addStringOption((o) => o.setName("id").setDescription("ユーザー/BotのID").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("一覧を表示"))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("検知の対象外にするユーザー")
    .addSubcommand((s) =>
      s.setName("add").setDescription("追加").addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("remove").setDescription("外す").addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("一覧を表示"))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("guard")
    .setDescription("参加者チェック/レイド対策(オプションなしで現在の設定を表示)")
    .addBooleanOption((o) => o.setName("enabled").setDescription("有効/無効"))
    .addIntegerOption((o) => o.setName("min_account_days").setDescription("これより新しいアカウントはキック(0で無効)").setMinValue(0).setMaxValue(365))
    .addBooleanOption((o) => o.setName("kick_default_avatar").setDescription("デフォルトアイコンの人をキック"))
    .addIntegerOption((o) => o.setName("raid_joins").setDescription("この人数でレイドとみなす").setMinValue(3).setMaxValue(100))
    .addIntegerOption((o) => o.setName("raid_window_sec").setDescription("数える秒数").setMinValue(3).setMaxValue(120))
    .addIntegerOption((o) => o.setName("lockdown_min").setDescription("レイド後に新規参加を拒否する分数").setMinValue(1).setMaxValue(1440))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("server_weakpoint")
    .setDescription("サーバーの弱点(ロール/権限/Bot/ユーザー)を診断")
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("auditlog_channel")
    .setDescription("ログの送信先チャンネルを設定(未指定で現在の設定を表示)")
    .addChannelOption((o) =>
      o.setName("channel").setDescription("送信先").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addBooleanOption((o) => o.setName("disable").setDescription("true=ログを止める"))
    .setDefaultMemberPermissions(ADMIN)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("このチャンネルのメッセージを一括削除")
    .addIntegerOption((o) => o.setName("amount").setDescription("件数(1〜100)").setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName("user").setDescription("このユーザーの発言だけ消す"))
    .setDefaultMemberPermissions(MOD)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("keyword_purge")
    .setDescription("キーワードを含むメッセージを一括削除")
    .addStringOption((o) => o.setName("keyword").setDescription("含まれる文字列").setRequired(true))
    .addIntegerOption((o) => o.setName("scan").setDescription("直近何件から探すか(既定100)").setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(MOD)
    .setDMPermission(false),
].map((c) => c.toJSON());

/** このファイルが担当するコマンド名(commands2側のコマンドは無視する) */
const OWN = new Set(definitions.map((d) => d.name));

export async function registerCommands(guild: Guild) {
  await guild.commands
    .set([...definitions, ...definitions2, ...contextDefs])
    .catch((e) => console.error(`コマンド登録失敗(${guild.name}):`, e.message));
}

// ===== ハンドラ =====
function configEmbed(title: string, rows: [string, string][]) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865f2)
    .setDescription(rows.map(([k, v]) => `**${k}**: ${v}`).join("\n"));
}

const reply = (i: ChatInputCommandInteraction, content: string) =>
  i.reply({ content, flags: MessageFlags.Ephemeral });

export function registerInteractions(client: Client) {
  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand() || !i.inGuild() || !i.guild || !OWN.has(i.commandName)) return;
    try {
      await handle(i, i.guild);
    } catch (e) {
      console.error("コマンドエラー:", e);
      const msg = "エラーが発生しました。Botの権限を確認してください。";
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
      else await reply(i, msg).catch(() => {});
    }
  });
}

async function handle(i: ChatInputCommandInteraction, guild: Guild) {
  const need = i.commandName === "purge" || i.commandName === "keyword_purge" ? MOD : ADMIN;
  if (!i.memberPermissions?.has(need)) return void (await reply(i, "このコマンドを使う権限がありません。"));

  const s = getSettings(guild.id);
  const o = i.options;

  switch (i.commandName) {
    case "antinuke": {
      const a = s.antinuke;
      a.enabled = o.getBoolean("enabled") ?? a.enabled;
      a.limit = o.getInteger("limit") ?? a.limit;
      a.windowSec = o.getInteger("window_sec") ?? a.windowSec;
      a.punishment = (o.getString("punishment") as typeof a.punishment) ?? a.punishment;
      a.alertMode = (o.getString("alert_mode") as typeof a.alertMode) ?? a.alertMode;
      save();
      return void (await i.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          configEmbed("AntiNuke", [
            ["状態", onOff(a.enabled)],
            ["発動条件", `${a.windowSec}秒以内にチャンネル/ロール削除・BAN・キックが${a.limit}回`],
            ["処罰", { strip: "危険な権限のロールを剥奪", kick: "キック", ban: "BAN" }[a.punishment]],
            ["アラートモード", a.alertMode === "high" ? "High(ホワイトリストも監視)" : "Normal"],
          ]),
        ],
      }));
    }

    case "invite_safemode": {
      const a = s.inviteSafe;
      if (o.getBoolean("unlock")) {
        const n = await unlockInvites(guild);
        await sendLog(guild, "🔓 InviteSafeMode 解除", `${i.user} が招待作成権限を${n}個のロールに戻しました。`, 0x2ecc71);
        return void (await reply(i, `招待作成権限を${n}個のロールに戻しました。`));
      }
      a.enabled = o.getBoolean("enabled") ?? a.enabled;
      a.limit = o.getInteger("limit") ?? a.limit;
      a.windowSec = o.getInteger("window_sec") ?? a.windowSec;
      save();
      return void (await i.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          configEmbed("InviteSafeMode", [
            ["状態", onOff(a.enabled)],
            ["発動条件", `${a.windowSec}秒以内に招待が${a.limit}個作られたら`],
            ["ロック中", a.lockedRoleIds.length ? `はい(${a.lockedRoleIds.length}ロール)` : "いいえ"],
          ]),
        ],
      }));
    }

    case "blacklist_add_image": {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const att = o.getAttachment("image", true);
      if (!att.contentType?.startsWith("image/")) return void (await i.editReply("画像ファイルを指定してください。"));
      const hash = await hashFromUrl(att.url).catch((e: Error) => e);
      if (hash instanceof Error) return void (await i.editReply(hash.message));
      if (findSimilar(s.imageHashes, hash)) return void (await i.editReply("すでに(似た画像が)登録されています。"));
      s.imageHashes.push(hash);
      save();
      await sendLog(guild, "🖼️ 画像ブラックリストに追加", `${i.user} が追加しました。(登録数: ${s.imageHashes.length})`, 0x9b59b6);
      return void (await i.editReply(`登録しました。(合計${s.imageHashes.length}枚)`));
    }

    case "blacklist_remove_image": {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const att = o.getAttachment("image", true);
      const hash = await hashFromUrl(att.url).catch((e: Error) => e);
      if (hash instanceof Error) return void (await i.editReply(hash.message));
      const found = findSimilar(s.imageHashes, hash);
      if (!found) return void (await i.editReply("その画像は登録されていません。"));
      s.imageHashes = s.imageHashes.filter((h) => h !== found);
      save();
      await sendLog(guild, "🖼️ 画像ブラックリストから削除", `${i.user} が外しました。(登録数: ${s.imageHashes.length})`, 0x9b59b6);
      return void (await i.editReply(`外しました。(合計${s.imageHashes.length}枚)`));
    }

    case "blacklist": {
      const sub = o.getSubcommand();
      if (sub === "list") {
        return void (await reply(i, s.blacklist.length ? s.blacklist.map((id) => `• \`${id}\``).join("\n") : "空です。"));
      }
      const id = o.getString("id", true).trim();
      if (!/^\d{15,22}$/.test(id)) return void (await reply(i, "IDは数字(15〜22桁)で指定してください。"));
      if (sub === "add") {
        if (!s.blacklist.includes(id)) s.blacklist.push(id);
        save();
        const member = await guild.members.fetch(id).catch(() => null);
        const banned = member ? await member.ban({ reason: "ブラックリスト登録" }).then(() => true).catch(() => false) : null;
        await sendLog(guild, "⛔ ブラックリストに追加", `${i.user} が \`${id}\` を追加しました。${banned === null ? "" : banned ? "\n参加中だったのでBANしました。" : "\n参加中でしたがBANに失敗しました。"}`, 0x9b59b6);
        return void (await reply(i, `追加しました。${banned ? "(参加中だったのでBANしました)" : ""}`));
      }
      s.blacklist = s.blacklist.filter((x) => x !== id);
      save();
      await sendLog(guild, "⛔ ブラックリストから削除", `${i.user} が \`${id}\` を外しました。`, 0x9b59b6);
      return void (await reply(i, "外しました。"));
    }

    case "whitelist": {
      const sub = o.getSubcommand();
      if (sub === "list") {
        return void (await reply(i, s.whitelist.length ? s.whitelist.map((id) => `• <@${id}>`).join("\n") : "空です。"));
      }
      const user = o.getUser("user", true);
      if (sub === "add") {
        if (!s.whitelist.includes(user.id)) s.whitelist.push(user.id);
      } else {
        s.whitelist = s.whitelist.filter((x) => x !== user.id);
      }
      save();
      return void (await reply(i, `${user} を${sub === "add" ? "追加" : "削除"}しました。`));
    }

    case "guard": {
      const g = s.guard;
      g.enabled = o.getBoolean("enabled") ?? g.enabled;
      g.minAccountDays = o.getInteger("min_account_days") ?? g.minAccountDays;
      g.kickDefaultAvatar = o.getBoolean("kick_default_avatar") ?? g.kickDefaultAvatar;
      g.raidJoins = o.getInteger("raid_joins") ?? g.raidJoins;
      g.raidWindowSec = o.getInteger("raid_window_sec") ?? g.raidWindowSec;
      g.lockdownMin = o.getInteger("lockdown_min") ?? g.lockdownMin;
      save();
      return void (await i.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          configEmbed("Guard", [
            ["状態", onOff(g.enabled)],
            ["新しいアカウント", g.minAccountDays ? `作成から${g.minAccountDays}日未満はキック` : "チェックしない"],
            ["デフォルトアイコン", g.kickDefaultAvatar ? "キック" : "許可"],
            ["レイド検知", `${g.raidWindowSec}秒で${g.raidJoins}人参加 → ${g.lockdownMin}分間ロックダウン`],
          ]),
        ],
      }));
    }

    case "server_weakpoint": {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      return void (await i.editReply({ embeds: [await scanWeakpoints(guild)] }));
    }

    case "auditlog_channel": {
      const ch = o.getChannel("channel");
      if (o.getBoolean("disable")) {
        s.logChannelId = "";
        save();
        return void (await reply(i, "ログを止めました。"));
      }
      if (!ch) {
        return void (await reply(i, s.logChannelId ? `現在の送信先: <#${s.logChannelId}>` : "ログの送信先は未設定です。"));
      }
      s.logChannelId = ch.id;
      save();
      await sendLog(guild, "📝 ログ送信先を設定", `${i.user} がこのチャンネルを送信先に設定しました。`, 0x2ecc71);
      return void (await reply(i, `<#${ch.id}> にログを送ります。`));
    }

    case "purge":
    case "keyword_purge": {
      const channel = i.channel;
      if (!channel || !("bulkDelete" in channel)) return void (await reply(i, "このチャンネルでは使えません。"));
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      let targets;
      let detail: string;
      if (i.commandName === "purge") {
        const amount = o.getInteger("amount", true);
        const user = o.getUser("user");
        const fetched = await channel.messages.fetch({ limit: 100 });
        targets = fetched
          .filter((m) => !user || m.author.id === user.id)
          .first(user ? amount : Math.min(amount, fetched.size));
        detail = `件数指定: ${amount}${user ? ` / 対象: <@${user.id}>` : ""}`;
      } else {
        const keyword = o.getString("keyword", true).toLowerCase();
        const scan = o.getInteger("scan") ?? 100;
        const fetched = await channel.messages.fetch({ limit: scan });
        targets = [...fetched.filter((m) => m.content.toLowerCase().includes(keyword)).values()];
        detail = `キーワード: \`${keyword}\` (直近${scan}件を検索)`;
      }

      markBotDeleted(targets.map((m) => m.id));
      const deleted = targets.length ? await channel.bulkDelete(targets, true) : null;
      const n = deleted?.size ?? 0;
      await sendLog(
        guild,
        i.commandName === "purge" ? "🧹 /purge" : "🧹 /keyword_purge",
        `**実行者**: ${i.user}\n**チャンネル**: <#${channel.id}>\n**${detail}**\n**削除**: ${n}件`,
        0x95a5a6,
      );
      return void (await i.editReply(
        `${n}件削除しました。` + (n < targets.length ? "\n(14日より古いメッセージは削除できません)" : ""),
      ));
    }
  }
}
