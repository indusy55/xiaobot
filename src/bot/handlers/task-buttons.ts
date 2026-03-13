import type { Bot } from "grammy";
import { buildTaskRetryKeyboard, parseTaskControlCallback } from "../task-controls.js";
import { TaskWorker } from "../../tasks/index.js";

export function setupTaskButtonHandler(bot: Bot, taskWorker: TaskWorker) {
  bot.on("callback_query:data", async (ctx, next) => {
    const control = parseTaskControlCallback(ctx.callbackQuery.data);
    if (!control) {
      return next();
    }

    const chatId = ctx.chat ? String(ctx.chat.id) : undefined;
    const scope = {
      ...(chatId ? { chatId } : {}),
      ...(ctx.from ? { userId: String(ctx.from.id) } : {}),
    };

    switch (control.action) {
      case "cancel": {
        const outcome = await taskWorker.requestCancel(control.taskId, scope);
        switch (outcome.result) {
          case "requested":
            await ctx.answerCallbackQuery({
              text: `Cancellation requested for task #${outcome.task?.id}.`,
            });
            return;
          case "cancelled":
            if (ctx.callbackQuery.message?.message_id != null && chatId) {
              await ctx.api.editMessageReplyMarkup(
                chatId,
                ctx.callbackQuery.message.message_id,
                {
                  reply_markup: buildTaskRetryKeyboard(control.taskId),
                }
              ).catch(() => undefined);
            }
            await ctx.answerCallbackQuery({
              text: `Task #${outcome.task?.id} cancelled.`,
            });
            return;
          case "already_finished":
            await ctx.answerCallbackQuery({
              text: `Task #${outcome.task?.id} is already finished.`,
            });
            return;
          case "not_found":
            await ctx.answerCallbackQuery({
              text: `Task #${control.taskId} was not found.`,
            });
            return;
        }
      }
      case "retry": {
        const outcome = await taskWorker.retryTask(control.taskId, scope);
        switch (outcome.result) {
          case "queued":
            await ctx.answerCallbackQuery({
              text: `Retry queued as task #${outcome.retriedTask?.id}.`,
            });
            return;
          case "not_finished":
            await ctx.answerCallbackQuery({
              text: `Task #${outcome.sourceTask?.id} is still running.`,
            });
            return;
          case "not_found":
            await ctx.answerCallbackQuery({
              text: `Task #${control.taskId} was not found.`,
            });
            return;
        }
      }
    }
  });
}
