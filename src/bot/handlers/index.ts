import type { Bot } from "grammy";
import type { ChatOpenAI } from "@langchain/openai";
import { TaskWorker } from "../../tasks/index.js";
import { setupAiPingHandler } from "./ai-ping.js";
import { setupChatHandler } from "./chat.js";
import { setupPingHandler } from "./ping.js";
import { setupTaskButtonHandler } from "./task-buttons.js";
import { setupTaskControlHandler } from "./task-control.js";

export function setupHandlers(
  bot: Bot,
  taskWorker: TaskWorker,
  chatModel: ChatOpenAI
) {
  setupPingHandler(bot);
  setupAiPingHandler(bot, chatModel);
  setupTaskControlHandler(bot, taskWorker);
  setupTaskButtonHandler(bot, taskWorker);
  setupChatHandler(bot);
}
