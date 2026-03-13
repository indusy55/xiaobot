import type { Bot } from "grammy";
import { TaskWorker } from "../../tasks/index.js";
import { setupChatHandler } from "./chat.js";
import { setupPingHandler } from "./ping.js";
import { setupTaskButtonHandler } from "./task-buttons.js";
import { setupTaskControlHandler } from "./task-control.js";

export function setupHandlers(bot: Bot, taskWorker: TaskWorker) {
  setupPingHandler(bot);
  setupTaskControlHandler(bot, taskWorker);
  setupTaskButtonHandler(bot, taskWorker);
  setupChatHandler(bot);
}
