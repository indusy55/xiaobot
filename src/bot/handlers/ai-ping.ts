import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { readChatPrompt } from "../../infra/ai/prompt.js";
import { logError } from "../../infra/error/index.js";
import type { AppBot } from "../types.js";

function extractText(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("")
    .trim();
}

export function setupAiPingHandler(bot: AppBot, chatModel: ChatOpenAI) {
  bot.command("ai_ping", async (ctx) => {
    try {
      await ctx.replyWithChatAction("typing").catch(() => undefined);

      const systemPrompt = await readChatPrompt();
      const response = await chatModel.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(
          "This is an AI health check. Reply in one short sentence that proves you are working."
        ),
      ]);
      const text = extractText(response.content) || "AI is working.";

      await ctx.reply(text, {
        reply_parameters: {
          message_id: ctx.msg.message_id,
        },
      });
    } catch (error) {
      logError("AI_PING", error, {
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        updateId: ctx.update.update_id,
      });
      await ctx.reply("AI ping failed.");
    }
  });
}
