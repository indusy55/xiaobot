import { loadConfig } from "../../config/index.js";
import { upsertStickerSet } from "../sticker-store.js";
import { logError } from "../../infra/error/index.js";
import type { AppBot } from "../types.js";

type StickerMessage = {
  text?: string;
  reply_to_message?: {
    sticker?: {
      set_name?: string;
    };
  };
  sticker?: {
    set_name?: string;
  };
};

function extractStickerSetName(message: StickerMessage) {
  const text = message.text?.trim() ?? "";
  const parts = text.split(/\s+/).filter((part) => part.length > 0);
  const commandArg = parts.slice(1).join(" ").trim();
  if (commandArg.length > 0) {
    return commandArg;
  }

  return (
    message.reply_to_message?.sticker?.set_name ??
    message.sticker?.set_name ??
    null
  );
}

export function setupAddSticketsetHandler(bot: AppBot) {
  bot.command(
    ["add_setstickerset", "add_sticketset", "add_stickerset"],
    async (ctx) => {
      const cfg = loadConfig();
      if (ctx.from?.id !== cfg.ADMIN_ID) {
        await ctx.reply("Forbidden.");
        return;
      }

      const setName = extractStickerSetName(ctx.msg as StickerMessage);
      if (!setName) {
        await ctx.reply(
          "Reply to a sticker or use /add_setstickerset <set_name>."
        );
        return;
      }

    try {
      const stickerSet = await ctx.api.getStickerSet(setName);
      const result = await upsertStickerSet({
        set: stickerSet,
        ...(ctx.from ? { createdByUserId: String(ctx.from.id) } : {}),
      });

      await ctx.reply(
        `Sticker set added: ${result.title} (${result.setName}), ${result.stickerCount} stickers.`
      );
      } catch (error) {
        logError("ADD_STICKERSET", error, {
          chatId: ctx.chat?.id,
          userId: ctx.from?.id,
          setName,
        });
        await ctx.reply("Failed to add sticker set.");
      }
    }
  );
}
