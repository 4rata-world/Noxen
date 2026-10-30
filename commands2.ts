import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import { getSettings, save, type LogType, type WordAction } from "./store.js";
import { DEFS, DEF_BY_KEY, cfg, isOn, type Group } from "./detect.js";
import { sendLog } from "./log.js";
import { LOG_LABELS, applyDmBlock, describeSettings, runAllSetup } from "./setup.js";
import { handleReport, reportContext } from "./report.js";
import { listSnapshots, restore, takeSnapshot } from "./rollback.js";

const ADMIN = PermissionFlagsBits.Administrator;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum] as const;

/** 管理者専用にする */
function adm<T extends { setDefaultMemberPermissions(p: bigint | number | string | null): T; setDMPermission(b: boolean): T }>(b: T): T {
  return b.setDefaultMemberPermissions(ADMIN).setDMPermission(false);
}
const pub = <T extends { setDMPermission(b: boolean): T }>(b: T): T => b.setDMPermission(false);

const cmd = (name: string, desc: string) => new SlashCommandBuilder().setName(name).setDescription(desc);

const logChoices = (Object.keys(LOG_LABELS) as LogType[]).map((k) => ({ name: LOG_LABELS[k], value: k }));
const stateChoices = [
  { name: "オン", value: "on" },
  { name: "オフ", value: "off" },
  { name: "状態確認", value: "status" },
];
const opChoices = [
  { name: "追加", value: "add" },
  { name: "削除", value: "remove" },
  { name: "一覧", value: "list" },
];

/** 「チャンネルの一覧」系コマンドの組(追加/削除/一覧) */
const CHANNEL_LISTS = [
  { add: "allowdiscordlink", remove: "denydiscordlink", list: "discordlinklist", field: "linkAllowed", label: "招待リンクを許可するチャンネル" },
  { add: "allowall", remove: "deleteall", list: "excludedlist", field: "excluded", label: "荒らし対策の除外チャンネル" },
  { add: "allowwebhook", remove: "deletewebhook", list: "webhooklist", field: "webhookExcluded", label: "Webhook連投検知の除外チャンネル" },
] as const;

const chanOpt = (o: any, desc = "対象チャンネル(省略で今のチャンネル)", required = false) =>
  o.setName("channel").setDescription(desc).addChannelTypes(...TEXT_TYPES).setRequired(required);

export const definitions2: any[] = [
  // ----- セットアップ -----
  adm(cmd("allsetup", "ログ・通報チャンネルを自動作成").addStringOption((o) =>
    o.setName("mode").setDescription("セットアップの範囲").setRequired(true).addChoices(
      { name: "フルセットアップ(参加通知・処罰ログも)", value: "full" },
      { name: "最低限のセットアップ(ログと通報のみ)", value: "min" },
    ),
  )),
  adm(cmd("viewsettings", "このBotの設定を一覧表示(自分だけに見える)")),
  adm(cmd("setlogchannel", "ログの送信先チャンネルを設定")
    .addStringOption((o) => o.setName("log_type").setDescription("ログの種類").setRequired(true).addChoices(...logChoices))
    .addChannelOption((o) => chanOpt(o, "送信先", true))),
  adm(cmd("join通知", "新規参加者の通知チャンネルを設定").addChannelOption((o) => chanOpt(o, "通知先", true))),
  adm(cmd("招待リンクログ", "新規参加者がどの招待リンクを使ったかを記録").addStringOption((o) =>
    o.setName("destination").setDescription("記録先").setRequired(true).addChoices(
      { name: "参加退出ログチャンネル", value: "join" },
      { name: "参加通知チャンネル", value: "notice" },
      { name: "無効化", value: "off" },
    ),
  )),
  adm(cmd("set自己紹介", "自己紹介チャンネルを設定(重複投稿は前のものを自動削除)").addChannelOption((o) => chanOpt(o, "チャンネル", true))),
  adm(cmd("set通報", "通報の送信先チャンネルを設定").addChannelOption((o) => chanOpt(o, "チャンネル", true))),
  adm(cmd("再起動ログ", "Bot再起動時に管理ログへ通知する").addStringOption((o) =>
    o.setName("state").setDescription("状態").setRequired(true).addChoices(
      { name: "オン", value: "on" },
      { name: "オフ", value: "off" },
    ),
  )),

  // ----- モデレーション -----
  adm(cmd("pin", "チャンネルの一番下に常に表示されるメッセージを設定(sticky)").addStringOption((o) =>
    o.setName("text").setDescription("表示する文章").setRequired(true).setMaxLength(1800),
  )),
  adm(cmd("unpin", "stickyを解除")),
  adm(cmd("notspeak", "コマンド以外の発言を禁止するチャンネル")
    .addStringOption((o) => o.setName("operation").setDescription("操作").setRequired(true).addChoices(...opChoices))
    .addChannelOption((o) => chanOpt(o))),
  ...CHANNEL_LISTS.flatMap((c) => [
    adm(cmd(c.add, `${c.label}に追加`).addChannelOption((o) => chanOpt(o))),
    adm(cmd(c.remove, `${c.label}から外す`).addChannelOption((o) => chanOpt(o))),
    adm(cmd(c.list, `${c.label}の一覧`)),
  ]),
  adm(cmd("word", "NGワードと処罰を追加")
    .addStringOption((o) => o.setName("word").setDescription("NGワード").setRequired(true).setMaxLength(100))
    .addStringOption((o) =>
      o.setName("action").setDescription("処罰").setRequired(true).addChoices(
        { name: "BAN", value: "BAN" },
        { name: "KICK", value: "KICK" },
        { name: "TIMEOUT(10分)", value: "TIMEOUT" },
        { name: "メッセージ削除のみ", value: "DELETEMESSAGE" },
      ),
    )),
  adm(cmd("word_remove", "NGワードを削除").addStringOption((o) => o.setName("word").setDescription("NGワード").setRequired(true))),
  adm(cmd("word_list", "NGワードの一覧")),
  adm(cmd("ratelimit", "特定ユーザーの発言数を制限")
    .addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true))
    .addIntegerOption((o) => o.setName("time_window").setDescription("数える時間(分)").setRequired(true).setMinValue(1).setMaxValue(1440))
    .addIntegerOption((o) => o.setName("max_messages").setDescription("その時間内の最大メッセージ数").setRequired(true).setMinValue(1).setMaxValue(100))
    .addIntegerOption((o) => o.setName("restriction_duration").setDescription("超えたときの制限時間(分)").setRequired(true).setMinValue(1).setMaxValue(10080))),
  adm(cmd("ratelimit_remove", "発言数の制限を解除").addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true))),
  adm(cmd("ratelimit_list", "発言数の制限の一覧")),
  adm(cmd("dmblock", "サーバー内のメンバー同士のDMを一時停止/再開(切り替え)")),
  adm(cmd("宣伝リミット", "宣伝チャンネルで同じ宣伝の繰り返しを制限(同じ内容は1週間に1回)")
    .addStringOption((o) => o.setName("operation").setDescription("操作").setRequired(true).addChoices(...opChoices))
    .addChannelOption((o) => chanOpt(o))),

  // ----- 荒らし対策(ユーザー) -----
  adm(cmd("荒らし対策", "ユーザー向け荒らし対策の全体スイッチ(省略で切り替え)").addBooleanOption((o) => o.setName("enabled").setDescription("ON/OFF"))),
  pub(cmd("荒らし対策状態", "ユーザー向け荒らし対策の現在の設定を表示")),
  adm(cmd("荒らし対策設定", "検知ごとの時間・しきい値・処罰時間・ON/OFFを設定")
    .addStringOption((o) => o.setName("detection").setDescription("検知の種類").setAutocomplete(true))
    .addBooleanOption((o) => o.setName("enabled").setDescription("この検知のON/OFF"))
    .addIntegerOption((o) => o.setName("window").setDescription("数える時間(秒)"))
    .addIntegerOption((o) => o.setName("threshold").setDescription("しきい値(回数/人数)"))
    .addIntegerOption((o) => o.setName("duration").setDescription("処罰(タイムアウト)の長さ(分)"))
    .addIntegerOption((o) => o.setName("count").setDescription("補助値(リアクション数/最大文字数/レイドの解除秒数)"))
    .addStringOption((o) =>
      o.setName("reset_group").setDescription("このカテゴリの設定を既定に戻す").addChoices(
        { name: "ユーザー向け", value: "user" },
        { name: "BOT向け", value: "bot" },
      ),
    )),
  adm(cmd("antispam", "スパム対策の簡易設定(荒らし対策設定の一部をまとめたもの)")
    .addBooleanOption((o) => o.setName("enabled").setDescription("有効/無効"))
    .addIntegerOption((o) => o.setName("window_sec").setDescription("連投を数える秒数").setMinValue(3).setMaxValue(120))
    .addIntegerOption((o) => o.setName("max_messages").setDescription("その時間内の最大メッセージ数").setMinValue(3).setMaxValue(50))
    .addIntegerOption((o) => o.setName("max_duplicates").setDescription("同じ内容の最大回数").setMinValue(2).setMaxValue(20))
    .addIntegerOption((o) => o.setName("max_mentions").setDescription("1メッセージの最大メンション数").setMinValue(3).setMaxValue(50))
    .addBooleanOption((o) => o.setName("block_invites").setDescription("招待リンクの投稿を禁止"))
    .addIntegerOption((o) => o.setName("timeout_min").setDescription("同一内容の連投のタイムアウト(分)").setMinValue(1).setMaxValue(10080))),
  adm(cmd("短縮リンクブロック", "短縮URL経由の招待リンクをブロック").addStringOption((o) =>
    o.setName("state").setDescription("状態").setRequired(true).addChoices(...stateChoices),
  )),
  adm(cmd("詐欺リンクブロック", "既知の詐欺サイトへのリンクをブロック(SCAM_LIST_URLのリストを使用)").addStringOption((o) =>
    o.setName("state").setDescription("状態").setRequired(true).addChoices(...stateChoices),
  )),

  // ----- 荒らし対策(BOT) -----
  adm(cmd("bot荒らし対策", "BOT向け荒らし対策の全体スイッチ(省略で切り替え)").addBooleanOption((o) => o.setName("enabled").setDescription("ON/OFF"))),
  pub(cmd("bot荒らし対策状態", "BOT向け荒らし対策の現在の設定を表示")),
  adm(cmd("bot荒らし対策例外", "特定のBotを監視から除外(もう一度実行すると解除)").addUserOption((o) => o.setName("bot").setDescription("対象のBot").setRequired(true))),
  adm(cmd("bot招待リンクブロック", "Botが送る招待リンク/短縮URL/NGワードのブロック(省略で切り替え)").addBooleanOption((o) => o.setName("enabled").setDescription("ON/OFF"))),
  adm(cmd("webhookspam", "Webhook連投ブロック(省略で切り替え)").addBooleanOption((o) => o.setName("enabled").setDescription("ON/OFF"))),

  // ----- ロールバック -----
  adm(cmd("ロールバック", "チャンネル・カテゴリ・ロールの構成を保存した状態に戻す(7日分)")
    .addSubcommand((s) =>
      s.setName("run").setDescription("消えたチャンネル/ロールを復元").addIntegerOption((o) =>
        o.setName("minutes_ago").setDescription("この分数より前の状態から復元(既定10分。荒らしの直前に戻したいときに調整)").setMinValue(0).setMaxValue(10080),
      ),
    )
    .addSubcommand((s) => s.setName("list").setDescription("保存されているスナップショットを表示"))
    .addSubcommand((s) => s.setName("snapshot").setDescription("今すぐスナップショットを保存"))
    .addSubcommand((s) =>
      s.setName("auto").setDescription("荒らし検知時の自動復元").addBooleanOption((o) => o.setName("enabled").setDescription("ON/OFF").setRequired(true)),
    )),
].map((c: any) => c.toJSON?.() ?? c);

export const contextDefs: any[] = [reportContext];
const OWN = new Set(definitions2.map((d: any) => d.name));
const PUBLIC = new Set(["荒らし対策状態", "bot荒らし対策状態"]);

const onOff = (b: boolean) => (b ? "✅ ON" : "❌ OFF");
const eph = { flags: MessageFlags.Ephemeral } as const;
const reply = (i: ChatInputCommandInteraction, content: string) => i.reply({ content, ...eph });

// ===== 荒らし対策の状態表示 =====
function statusEmbed(guild: Guild, group: Group): EmbedBuilder {
  const s = getSettings(guild.id);
  const globalOn = group === "user" ? s.anti.enabled : s.botGuard.enabled;
  const lines = DEFS.filter((d) => d.group === group).map((d) => {
    const c = cfg(guild.id, d.key);
    const parts: string[] = [];
    if (d.window) parts.push(`${c.window}秒`);
    if (d.threshold) parts.push(`しきい値${c.threshold}`);
    if (d.count) parts.push(`${d.countLabel ?? "補助値"}${c.count}`);
    if (d.duration) parts.push(`処罰${c.duration}分`);
    if (d.steps?.length) parts.push(`段階処罰[${d.steps.map((x) => (x ? `${x}分` : "警告")).join("→")}]`);
    if (d.note) parts.push(d.note);
    return `${isOn(guild.id, d.key) ? "✅" : "❌"} **${d.label}** — ${parts.join(" / ") || "—"}`;
  });
  const extra =
    group === "user"
      ? `短縮リンクブロック: ${onOff(s.anti.shortLinkBlock)} / 詐欺リンクブロック: ${onOff(s.anti.scamLinkBlock)}`
      : `BOT招待リンクブロック: ${onOff(s.botGuard.inviteBlock)} / 例外Bot: ${s.botGuard.exceptions.length}件`;
  return new EmbedBuilder()
    .setTitle(group === "user" ? "🛡️ 荒らし対策(ユーザー)" : "🤖 荒らし対策(BOT)")
    .setColor(globalOn ? 0x2ecc71 : 0x95a5a6)
    .setDescription(`全体: ${onOff(globalOn)}\n${extra}\n\n${lines.join("\n")}`.slice(0, 4000));
}

const stateTo = (i: ChatInputCommandInteraction, cur: boolean): boolean | null => {
  const st = i.options.getString("state", true);
  return st === "status" ? null : st === "on";
};

// ===== オートコンプリート =====
async function autocomplete(i: AutocompleteInteraction) {
  if (i.commandName !== "荒らし対策設定") return;
  const q = i.options.getFocused().toLowerCase();
  const items = DEFS.filter((d) => d.label.toLowerCase().includes(q) || d.key.toLowerCase().includes(q))
    .slice(0, 25)
    .map((d) => ({ name: `${d.group === "bot" ? "[BOT] " : ""}${d.label}`.slice(0, 100), value: d.key }));
  await i.respond(items);
}

// ===== 各コマンド =====
async function handle(i: ChatInputCommandInteraction, guild: Guild) {
  if (!PUBLIC.has(i.commandName) && !i.memberPermissions?.has(ADMIN)) {
    return void (await reply(i, "このコマンドは管理者のみ使えます。"));
  }
  const s = getSettings(guild.id);
  const o = i.options;
  const name = i.commandName;
  const here = () => (o.getChannel("channel")?.id ?? i.channelId) as string;

  // ----- チャンネル一覧系 -----
  for (const c of CHANNEL_LISTS) {
    if (name !== c.add && name !== c.remove && name !== c.list) continue;
    const arr = s[c.field] as string[];
    if (name === c.list) {
      return void (await reply(i, `**${c.label}**\n${arr.length ? arr.map((x) => `• <#${x}>`).join("\n") : "なし"}`));
    }
    const id = here();
    if (name === c.add) {
      if (!arr.includes(id)) arr.push(id);
    } else {
      (s as any)[c.field] = arr.filter((x) => x !== id);
    }
    save();
    return void (await reply(i, `<#${id}> を${c.label}${name === c.add ? "に追加" : "から外"}しました。`));
  }

  switch (name) {
    case "allsetup": {
      await i.deferReply(eph);
      try {
        const lines = await runAllSetup(guild, o.getString("mode", true) as "full" | "min");
        return void (await i.editReply(`セットアップ完了\n${lines.join("\n")}`));
      } catch (e: any) {
        return void (await i.editReply(`セットアップに失敗しました。Botに「チャンネルの管理」権限があるか確認してください。\n${e?.message ?? ""}`));
      }
    }
    case "viewsettings":
      return void (await i.reply({ embeds: [describeSettings(guild)], ...eph }));

    case "setlogchannel": {
      const t = o.getString("log_type", true) as LogType;
      s.logChannels[t] = o.getChannel("channel", true).id;
      save();
      return void (await reply(i, `${LOG_LABELS[t]} を <#${s.logChannels[t]}> に設定しました。`));
    }
    case "join通知":
      s.joinNoticeChannelId = o.getChannel("channel", true).id;
      save();
      return void (await reply(i, `参加通知を <#${s.joinNoticeChannelId}> に設定しました。`));
    case "招待リンクログ": {
      s.inviteLogDest = o.getString("destination", true) as typeof s.inviteLogDest;
      save();
      return void (await reply(i, `招待リンクログ: ${{ join: "参加退出ログ", notice: "参加通知", off: "無効" }[s.inviteLogDest]}\n(Botに「サーバー管理」権限が必要です)`));
    }
    case "set自己紹介":
      s.introChannelId = o.getChannel("channel", true).id;
      save();
      return void (await reply(i, `自己紹介チャンネルを <#${s.introChannelId}> に設定しました。`));
    case "set通報":
      s.reportChannelId = o.getChannel("channel", true).id;
      save();
      return void (await reply(i, `通報の送信先を <#${s.reportChannelId}> に設定しました。`));
    case "再起動ログ":
      s.restartLog = o.getString("state", true) === "on";
      save();
      return void (await reply(i, `再起動ログ: ${onOff(s.restartLog)}`));

    // ----- sticky -----
    case "pin": {
      const text = o.getString("text", true);
      const old = s.sticky[i.channelId];
      if (old?.lastId && i.channel && "messages" in i.channel) await i.channel.messages.delete(old.lastId).catch(() => {});
      const sent = i.channel && "send" in i.channel ? await i.channel.send(`📌 ${text}`).catch(() => null) : null;
      s.sticky[i.channelId] = { text, lastId: sent?.id ?? "" };
      save();
      return void (await reply(i, "stickyを設定しました。新しい発言があるたびに一番下に再投稿されます。"));
    }
    case "unpin": {
      const old = s.sticky[i.channelId];
      if (!old) return void (await reply(i, "このチャンネルにstickyはありません。"));
      if (old.lastId && i.channel && "messages" in i.channel) await i.channel.messages.delete(old.lastId).catch(() => {});
      delete s.sticky[i.channelId];
      save();
      return void (await reply(i, "stickyを解除しました。"));
    }
    case "notspeak": {
      const op = o.getString("operation", true);
      if (op === "list") return void (await reply(i, s.notSpeak.length ? s.notSpeak.map((x) => `• <#${x}>`).join("\n") : "なし"));
      const id = here();
      if (op === "add") {
        if (!s.notSpeak.includes(id)) s.notSpeak.push(id);
      } else {
        s.notSpeak = s.notSpeak.filter((x) => x !== id);
      }
      save();
      return void (await reply(i, `<#${id}> を${op === "add" ? "コマンド専用に追加" : "コマンド専用から外"}しました。(管理者以外の発言は削除されます)`));
    }
    case "宣伝リミット": {
      const op = o.getString("operation", true);
      if (op === "list") return void (await reply(i, s.promoChannels.length ? s.promoChannels.map((x) => `• <#${x}>`).join("\n") : "なし"));
      const id = here();
      if (op === "add") {
        if (!s.promoChannels.includes(id)) s.promoChannels.push(id);
      } else {
        s.promoChannels = s.promoChannels.filter((x) => x !== id);
      }
      save();
      return void (await reply(i, `<#${id}> を宣伝リミットの${op === "add" ? "対象に追加" : "対象から外"}しました。\n同じ内容を1週間に2回投稿すると警告、3回目は削除します。(管理者は対象外)`));
    }

    // ----- NGワード -----
    case "word": {
      const word = o.getString("word", true).trim();
      const action = o.getString("action", true) as WordAction;
      if (s.words.length >= 100 && !s.words.some((w) => w.word === word)) return void (await reply(i, "NGワードは100件までです。"));
      s.words = s.words.filter((w) => w.word.toLowerCase() !== word.toLowerCase());
      s.words.push({ word, action });
      save();
      await sendLog(guild, "🚫 NGワードを追加", `${i.user} が追加: ||${word}|| → ${action}`, 0x9b59b6);
      return void (await reply(i, `追加しました: ||${word}|| → ${action}`));
    }
    case "word_remove": {
      const word = o.getString("word", true).trim().toLowerCase();
      const before = s.words.length;
      s.words = s.words.filter((w) => w.word.toLowerCase() !== word);
      save();
      return void (await reply(i, before === s.words.length ? "そのNGワードは登録されていません。" : "削除しました。"));
    }
    case "word_list":
      return void (await reply(i, s.words.length ? s.words.map((w) => `• ||${w.word}|| → ${w.action}`).join("\n").slice(0, 1900) : "なし"));

    // ----- レート制限 -----
    case "ratelimit": {
      const u = o.getUser("user", true);
      s.rateLimits[u.id] = {
        windowMin: o.getInteger("time_window", true),
        max: o.getInteger("max_messages", true),
        durMin: o.getInteger("restriction_duration", true),
      };
      save();
      const r = s.rateLimits[u.id];
      return void (await reply(i, `${u} は${r.windowMin}分で${r.max}件までに制限しました。超えるとメッセージを削除して${r.durMin}分タイムアウトします。`));
    }
    case "ratelimit_remove": {
      const u = o.getUser("user", true);
      delete s.rateLimits[u.id];
      save();
      return void (await reply(i, `${u} の制限を解除しました。`));
    }
    case "ratelimit_list": {
      const e = Object.entries(s.rateLimits);
      return void (await reply(i, e.length ? e.map(([id, r]) => `• <@${id}>: ${r.windowMin}分で${r.max}件まで / 超過で${r.durMin}分制限`).join("\n").slice(0, 1900) : "なし"));
    }
    case "dmblock": {
      await i.deferReply(eph);
      const next = !s.dmBlock;
      const ok = await applyDmBlock(guild, next);
      if (!ok) return void (await i.editReply("切り替えに失敗しました。Botに「サーバー管理」権限が必要です。"));
      s.dmBlock = next;
      save();
      await sendLog(guild, next ? "📵 DMブロック開始" : "📱 DMブロック解除", `${i.user} が切り替えました。`, 0xe67e22);
      return void (await i.editReply(next ? "メンバー同士のDMを一時停止しました。(フレンド・モデレーター・Botは送れます。解除するまで自動で延長します)" : "DMを再開しました。"));
    }

    // ----- 荒らし対策(ユーザー) -----
    case "荒らし対策": {
      s.anti.enabled = o.getBoolean("enabled") ?? !s.anti.enabled;
      save();
      return void (await reply(i, `ユーザー向け荒らし対策: ${onOff(s.anti.enabled)}(個別設定より優先されます)`));
    }
    case "荒らし対策状態":
      return void (await i.reply({ embeds: [statusEmbed(guild, "user")], ...eph }));
    case "bot荒らし対策状態":
      return void (await i.reply({ embeds: [statusEmbed(guild, "bot")], ...eph }));
    case "荒らし対策設定":
      return void (await configureDetection(i, guild));
    case "antispam": {
      const ov = s.anti.overrides;
      const set = (k: string, f: "window" | "threshold" | "duration", v: number | null) => {
        if (v !== null) (ov[k] ??= {})[f] = v;
      };
      s.anti.enabled = o.getBoolean("enabled") ?? s.anti.enabled;
      set("messageSpam", "window", o.getInteger("window_sec"));
      set("messageSpam", "threshold", o.getInteger("max_messages"));
      set("duplicate", "threshold", o.getInteger("max_duplicates"));
      set("massMention", "threshold", o.getInteger("max_mentions"));
      set("duplicate", "duration", o.getInteger("timeout_min"));
      const bi = o.getBoolean("block_invites");
      if (bi !== null) (ov.invite ??= {}).enabled = bi;
      save();
      return void (await i.reply({ embeds: [statusEmbed(guild, "user")], ...eph }));
    }
    case "短縮リンクブロック":
    case "詐欺リンクブロック": {
      const key = name === "短縮リンクブロック" ? "shortLinkBlock" : "scamLinkBlock";
      const next = stateTo(i, s.anti[key]);
      if (next !== null) {
        s.anti[key] = next;
        save();
      }
      const note = key === "scamLinkBlock" && !process.env.SCAM_LIST_URL ? "\n⚠️ 環境変数 SCAM_LIST_URL が未設定のため、リストが空で何もブロックされません。" : "";
      return void (await reply(i, `${name}: ${onOff(s.anti[key])}${note}`));
    }

    // ----- 荒らし対策(BOT) -----
    case "bot荒らし対策": {
      s.botGuard.enabled = o.getBoolean("enabled") ?? !s.botGuard.enabled;
      save();
      return void (await reply(i, `BOT向け荒らし対策: ${onOff(s.botGuard.enabled)}`));
    }
    case "bot荒らし対策例外": {
      const u = o.getUser("bot", true);
      if (!u.bot) return void (await reply(i, "Botを指定してください。"));
      const has = s.botGuard.exceptions.includes(u.id);
      s.botGuard.exceptions = has ? s.botGuard.exceptions.filter((x) => x !== u.id) : [...s.botGuard.exceptions, u.id];
      save();
      return void (await reply(i, `${u} を監視から${has ? "戻しました" : "除外しました"}。`));
    }
    case "bot招待リンクブロック": {
      s.botGuard.inviteBlock = o.getBoolean("enabled") ?? !s.botGuard.inviteBlock;
      save();
      return void (await reply(i, `BOT招待リンクブロック: ${onOff(s.botGuard.inviteBlock)}`));
    }
    case "webhookspam": {
      s.botGuard.webhookSpam = o.getBoolean("enabled") ?? !s.botGuard.webhookSpam;
      save();
      return void (await reply(i, `Webhook連投ブロック: ${onOff(s.botGuard.webhookSpam)}`));
    }

    // ----- ロールバック -----
    case "ロールバック": {
      const sub = o.getSubcommand();
      if (sub === "auto") {
        s.rollback.autoRestore = o.getBoolean("enabled", true);
        save();
        return void (await reply(i, `自動ロールバック: ${onOff(s.rollback.autoRestore)}\n(BOT荒らし対策/AntiNukeが発動した約5秒後に、消えたチャンネルとロールを復元します)`));
      }
      if (sub === "list") {
        const snaps = listSnapshots(guild.id);
        if (!snaps.length) return void (await reply(i, "スナップショットはまだありません。(起動の30秒後と、その後10分ごとに構成が変わっていれば保存します)"));
        const last = snaps.slice(-10).reverse().map((x) => `• <t:${Math.floor(x.at / 1000)}:f> — ロール${x.roles.length} / チャンネル${x.channels.length}`);
        return void (await reply(i, `**保存数**: ${snaps.length}件(最大7日分)\n**新しい順**\n${last.join("\n")}`));
      }
      if (sub === "snapshot") {
        await i.deferReply(eph);
        const saved = await takeSnapshot(guild);
        return void (await i.editReply(saved ? "スナップショットを保存しました。" : "保存しませんでした。(構成が前回から変わっていない、または荒らし検知直後で一時停止中です)"));
      }
      await i.deferReply(eph);
      const mins = o.getInteger("minutes_ago") ?? 10;
      const r = await restore(guild, mins);
      if (!r) return void (await i.editReply(`${mins}分より前のスナップショットがありません。\`/ロールバック list\` で確認してください。`));
      await sendLog(
        guild,
        "♻️ ロールバック",
        `${i.user} が <t:${Math.floor(r.snapAt / 1000)}:f> の状態から復元しました。\nロール${r.rolesCreated}個 / チャンネル${r.channelsCreated}個を再作成(失敗${r.failed})`,
        0x2ecc71,
      );
      return void (await i.editReply(
        `<t:${Math.floor(r.snapAt / 1000)}:f> の状態から復元しました。\nロール${r.rolesCreated}個 / チャンネル${r.channelsCreated}個を再作成(失敗${r.failed})\n` +
          "※メッセージ・招待・Webhook・メンバーのロールは復元されません。復元したロールを元のメンバーへ付け直す機能もありません。",
      ));
    }
  }
}

// ===== /荒らし対策設定 =====
async function configureDetection(i: ChatInputCommandInteraction, guild: Guild) {
  const s = getSettings(guild.id);
  const o = i.options;

  const resetGroup = o.getString("reset_group") as Group | null;
  if (resetGroup) {
    if (resetGroup === "user") s.anti.overrides = {};
    else s.botGuard.overrides = {};
    save();
    return void (await i.reply({ content: `${resetGroup === "user" ? "ユーザー向け" : "BOT向け"}の検知設定を既定に戻しました。`, ...eph }));
  }

  const key = o.getString("detection");
  const def = key ? DEF_BY_KEY.get(key) : undefined;
  if (!def) return void (await i.reply({ content: "`detection` で検知の種類を選んでください。(入力すると候補が出ます)", ...eph }));

  const ov = def.group === "user" ? s.anti.overrides : s.botGuard.overrides;
  const patch: Record<string, number | boolean> = {};
  const errors: string[] = [];

  const en = o.getBoolean("enabled");
  if (en !== null) patch.enabled = en;
  for (const f of ["window", "threshold", "duration", "count"] as const) {
    const v = o.getInteger(f);
    if (v === null) continue;
    const range = def.ranges[f];
    if (!range) errors.push(`「${def.label}」では ${f} を変更できません。`);
    else if (v < range[0] || v > range[1]) errors.push(`${f} は ${range[0]}〜${range[1]} の範囲で指定してください。`);
    else patch[f] = v;
  }
  if (errors.length) return void (await i.reply({ content: errors.join("\n"), ...eph }));
  if (Object.keys(patch).length) {
    ov[def.key] = { ...(ov[def.key] ?? {}), ...patch };
    save();
  }

  const c = cfg(guild.id, def.key);
  const r = def.ranges;
  const fmt = (n: string, v: number, rg?: [number, number]) => (rg ? `${n}: **${v}** (${rg[0]}〜${rg[1]})\n` : "");
  return void (await i.reply({
    content:
      `**${def.label}** ${onOff(isOn(guild.id, def.key))}\n` +
      fmt("window(秒)", c.window, r.window) +
      fmt("threshold", c.threshold, r.threshold) +
      fmt("duration(分)", c.duration, r.duration) +
      fmt(def.countLabel ?? "count", c.count, r.count) +
      (Object.keys(r).length ? "" : "この検知はON/OFFのみ変更できます。\n") +
      (def.note ? `メモ: ${def.note}` : ""),
    ...eph,
  }));
}

export function registerInteractions2(client: Client) {
  client.on("interactionCreate", async (i) => {
    try {
      if (i.isAutocomplete()) return void (await autocomplete(i));
      if (i.isMessageContextMenuCommand() || i.isButton() || i.isModalSubmit()) {
        if (await handleReport(i)) return;
      }
      if (i.isChatInputCommand() && i.guild && OWN.has(i.commandName)) await handle(i, i.guild);
    } catch (e) {
      console.error("commands2:", e);
      if (i.isRepliable()) {
        const msg = "エラーが発生しました。Botの権限を確認してください。";
        if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
        else await i.reply({ content: msg, ...eph }).catch(() => {});
      }
    }
  });
}
