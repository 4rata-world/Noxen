import { Events, type Client } from "discord.js";
import { getSettings, save } from "./store.js";
import { hit } from "./util.js";
import { sendLog } from "./log.js";

const lockdownUntil = new Map<string, number>();

export function registerGuard(client: Client) {
  // Botブラックリスト: 参加した瞬間にBAN
  client.on(Events.GuildMemberAdd, async (member) => {
    const guild = member.guild;
    const s = getSettings(guild.id);

    if (s.blacklist.includes(member.id)) {
      const ok = await member.ban({ reason: "ブラックリスト登録済み" }).then(() => true).catch(() => false);
      await sendLog(
        guild,
        "⛔ ブラックリストのIDをBAN",
        `<@${member.id}> (${member.user.tag}) ${member.user.bot ? "[Bot]" : ""}\n結果: ${ok ? "BAN" : "失敗(権限/順位を確認)"}`,
        0xe74c3c,
        "punish",
      );
      return;
    }

    const g = s.guard;
    if (!g.enabled || member.user.bot) return;

    const kick = async (why: string) => {
      const ok = await member.kick(`Guard: ${why}`).then(() => true).catch(() => false);
      await sendLog(
        guild,
        "🚪 Guard: 参加者をキック",
        `<@${member.id}> (${member.user.tag})\n理由: ${why}\n結果: ${ok ? "キック" : "失敗"}`,
        0xe67e22,
      );
    };

    // レイドのロックダウン中
    if ((lockdownUntil.get(guild.id) ?? 0) > Date.now()) return void (await kick("レイド対策のロックダウン中"));

    // レイド検知
    const joins = hit(`join:${guild.id}`, g.raidWindowSec * 1000);
    if (joins >= g.raidJoins) {
      lockdownUntil.set(guild.id, Date.now() + g.lockdownMin * 60_000);
      await sendLog(
        guild,
        "🚨 レイドを検知",
        `${g.raidWindowSec}秒以内に${joins}人が参加。${g.lockdownMin}分間、新規参加者をキックします。`,
        0xc0392b,
      );
      return void (await kick("レイド検知"));
    }

    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (ageDays < g.minAccountDays) return void (await kick(`アカウント作成から${ageDays.toFixed(1)}日`));
    if (g.kickDefaultAvatar && member.user.avatar === null) return void (await kick("デフォルトアイコン"));
  });

  // Botの活動記録(server_weakpointの「長期間動いていないBot」判定用)
  let lastSave = 0;
  client.on(Events.MessageCreate, (m) => {
    if (!m.inGuild() || !m.author.bot || m.author.id === client.user?.id) return;
    const s = getSettings(m.guild.id);
    s.botActivity[m.author.id] = Date.now();
    if (Date.now() - lastSave > 60_000) {
      lastSave = Date.now();
      save();
    }
  });

  client.once(Events.ClientReady, (c) => {
    for (const g of c.guilds.cache.values()) {
      const s = getSettings(g.id);
      if (!s.botTrackingSince) s.botTrackingSince = Date.now();
    }
    save();
  });
  client.on(Events.GuildCreate, (g) => {
    const s = getSettings(g.id);
    if (!s.botTrackingSince) s.botTrackingSince = Date.now();
    save();
  });
}
