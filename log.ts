import { EmbedBuilder, type Guild } from "discord.js";
import { getSettings, type LogType } from "./store.js";

/** type別のログチャンネルへ送る。未設定なら /auditlog_channel の送信先を使う */
export async function sendLog(
  guild: Guild,
  title: string,
  description: string,
  color = 0xe74c3c,
  type: LogType = "admin",
) {
  const s = getSettings(guild.id);
  const id = s.logChannels[type] || s.logChannelId;
  if (!id) return;
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (ch && ch.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description.slice(0, 4000))
      .setColor(color)
      .setTimestamp();
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}
