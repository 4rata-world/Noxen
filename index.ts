import "dotenv/config";
import http from "node:http";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { registerAntiNuke } from "./antinuke.js";
import { registerInviteSafe } from "./invites.js";
import { registerImageBlacklist } from "./images.js";
import { registerGuard } from "./guard.js";
import { registerAuditLog } from "./auditlog.js";
import { registerMessageGuard } from "./messageguard.js";
import { registerEventGuard } from "./eventguard.js";
import { registerBotGuard } from "./botguard.js";
import { registerRollback } from "./rollback.js";
import { registerSetup } from "./setup.js";
import { registerCommands, registerInteractions } from "./commands.js";
import { registerInteractions2 } from "./commands2.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN が設定されていません(.env を確認)");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 特権: 参加検知・メンバー診断
    GatewayIntentBits.GuildModeration, // BAN/キックの検知
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildVoiceStates, // VC入退室の検知・ログ
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions, // リアクション連投の検知
    GatewayIntentBits.MessageContent, // 特権: 本文の検査
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction],
});

registerMessageGuard(client);
registerEventGuard(client);
registerBotGuard(client);
registerAntiNuke(client);
registerInviteSafe(client);
registerImageBlacklist(client);
registerGuard(client);
registerAuditLog(client);
registerRollback(client);
registerSetup(client);
registerInteractions(client);
registerInteractions2(client);

client.once(Events.ClientReady, async (c) => {
  console.log(`ログインしました: ${c.user.tag} (${c.guilds.cache.size}サーバー)`);
  for (const g of c.guilds.cache.values()) await registerCommands(g);
});
client.on(Events.GuildCreate, (g) => void registerCommands(g));

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

// Renderなどのweb service向けのヘルスチェック(PORTがあるときだけ起動)
if (process.env.PORT) {
  http
    .createServer((_, res) => {
      res.writeHead(200).end("ok");
    })
    .listen(Number(process.env.PORT));
}

client.login(token);
