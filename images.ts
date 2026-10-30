import sharp from "sharp";
import { Events, PermissionFlagsBits, type Client } from "discord.js";
import { getSettings } from "./store.js";
import { isExempt, safeDelete } from "./util.js";
import { sendLog } from "./log.js";

const MAX_BYTES = 10 * 1024 * 1024;
/** この距離以内なら同じ画像とみなす(64bit中)。リサイズや再圧縮に強い */
const MAX_DISTANCE = 6;

/** 9x8のグレースケールに縮小して隣り合う画素を比較する dHash(16進16桁) */
export async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf, { animated: false })
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function distance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export const findSimilar = (hashes: string[], h: string) =>
  hashes.find((x) => distance(x, h) <= MAX_DISTANCE);

export async function hashFromUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("画像が大きすぎます(10MBまで)");
  return dHash(buf);
}

export function registerImageBlacklist(client: Client) {
  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || message.author.bot) return;
    const guild = message.guild;
    const s = getSettings(guild.id);
    if (s.imageHashes.length === 0) return;
    if (isExempt(guild, message.author.id)) return;
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const images = [...message.attachments.values()].filter(
      (a) => a.contentType?.startsWith("image/") && a.size <= MAX_BYTES,
    );
    for (const att of images) {
      let hash: string;
      try {
        hash = await hashFromUrl(att.url);
      } catch {
        continue;
      }
      if (!findSimilar(s.imageHashes, hash)) continue;

      await safeDelete(message);
      const timedOut = message.member?.moderatable
        ? await message.member
            .timeout(10 * 60_000, "ブラックリスト画像の投稿")
            .then(() => true)
            .catch(() => false)
        : false;
      await sendLog(
        guild,
        "🖼️ ブラックリスト画像を削除",
        `**ユーザー**: <@${message.author.id}> (${message.author.tag})\n` +
          `**チャンネル**: <#${message.channelId}>\n**タイムアウト**: ${timedOut ? "10分" : "未実行"}`,
        0xe74c3c,
        "punish",
      );
      return;
    }
  });
}
