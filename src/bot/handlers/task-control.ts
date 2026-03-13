import type { Bot } from "grammy";
import { TaskWorker } from "../../tasks/index.js";
import { resolveConversationIdFromMessageHistory } from "../conversation-store.js";
import { buildConversationId } from "../conversation.js";

function parseTaskId(text: string) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    return undefined;
  }

  const taskId = Number(parts[1]);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : undefined;
}

export function setupTaskControlHandler(bot: Bot, taskWorker: TaskWorker) {
  bot.command("cancel", async (ctx) => {
    const threadId =
      typeof ctx.msg.message_thread_id === "number"
        ? ctx.msg.message_thread_id
        : undefined;
    const chatId = String(ctx.chat.id);
    const baseConversationId = buildConversationId(chatId, ctx.chat.type, threadId);
    const replyToTelegramMessageId =
      typeof ctx.msg.reply_to_message?.message_id === "number"
        ? ctx.msg.reply_to_message.message_id
        : undefined;
    const conversationId =
      replyToTelegramMessageId == null
        ? baseConversationId
        : (await resolveConversationIdFromMessageHistory({
            chatId,
            telegramMessageId: replyToTelegramMessageId,
            baseConversationId,
            ...(threadId == null ? {} : { threadId }),
          })) ?? baseConversationId;

    const scope = {
      chatId,
      conversationId,
      ...(ctx.from ? { userId: String(ctx.from.id) } : {}),
    };

    const taskId = parseTaskId(ctx.msg.text);
    const outcome =
      taskId === undefined
        ? await taskWorker.requestCancelLatest(scope)
        : await taskWorker.requestCancel(taskId, scope);

    switch (outcome.result) {
      case "requested":
        await ctx.reply(`Cancellation requested for task #${outcome.task?.id}.`);
        return;
      case "cancelled":
        await ctx.reply(`Task #${outcome.task?.id} cancelled.`);
        return;
      case "already_finished":
        await ctx.reply(`Task #${outcome.task?.id} is already finished.`);
        return;
      case "not_found":
        await ctx.reply(
          taskId === undefined
            ? "No cancellable task found in this conversation."
            : `Task #${taskId} was not found in this conversation.`
        );
        return;
    }
  });
}
