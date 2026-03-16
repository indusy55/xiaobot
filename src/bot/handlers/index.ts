import type { ChatOpenAI } from "@langchain/openai";
import { TaskWorker } from "../../tasks/index.js";
import { setupAddSticketsetHandler } from "./add-sticketset.js";
import { setupAiPingHandler } from "./ai-ping.js";
import { setupChatHandler } from "./chat.js";
import { setupPingHandler } from "./ping.js";
import { setupTaskButtonHandler } from "./task-buttons.js";
import { setupTaskControlHandler } from "./task-control.js";
import type { AppBot } from "../types.js";

export function setupHandlers(
  bot: AppBot,
  taskWorker: TaskWorker,
  chatModel: ChatOpenAI
) {
  setupPingHandler(bot);
  setupAiPingHandler(bot, chatModel);
  setupAddSticketsetHandler(bot);
  setupTaskControlHandler(bot, taskWorker);
  setupTaskButtonHandler(bot, taskWorker);
  setupChatHandler(bot);
}
