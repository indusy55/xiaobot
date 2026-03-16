import { hydrateFiles } from "@grammyjs/files";
import { Bot, type BotError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { botCommands } from "./bot/commands.js";
import type { AppApi, AppContext } from "./bot/types.js";
import { setupHandlers } from "./bot/handlers/index.js";
import { setupMessageLoggerMiddleware } from "./bot/middleware/message-logger.js";
import { setupMessagePersistenceMiddleware } from "./bot/middleware/message-persistence.js";
import { loadConfig } from "./config/index.js";
import { createChatModel, createDecisionModel } from "./infra/ai/openai.js";
import { logError } from "./infra/error/index.js";
import { logger } from "./infra/logger/index.js";
import { enqueueChatTask, TaskWorker } from "./tasks/index.js";

function main() {
	try {
		const cfg = loadConfig();

		const bot = new Bot<AppContext, AppApi>(cfg.BOT_TOKEN);
		bot.api.config.use(hydrateFiles(bot.token));
		const chatModel = createChatModel(cfg);
		const decisionModel = createDecisionModel(cfg);
		let taskWorker: TaskWorker;
		taskWorker = new TaskWorker({
			api: bot.api,
			chatModel,
			decisionModel,
			taskTimeoutMs: cfg.TASK_TIMEOUT_MS,
			chatDecisionTimeoutMs: cfg.CHAT_DECISION_TIMEOUT_MS,
			chatContextLimit: cfg.CHAT_CONTEXT_LIMIT,
			chatContextSummaryLimit: cfg.CHAT_CONTEXT_SUMMARY_LIMIT,
			telegramMediaCacheDir: cfg.TELEGRAM_MEDIA_CACHE_DIR,
			taskRuntime: {
				enqueueChatTask,
				requestCancelLatest: (scope) => taskWorker.requestCancelLatest(scope),
			},
		}, 3, cfg.TASK_WORKER_CONCURRENCY);

		setupMessagePersistenceMiddleware(bot);
		setupMessageLoggerMiddleware(bot);
		setupHandlers(bot, taskWorker, chatModel);
		taskWorker.startPolling();

		bot.catch((err: BotError<AppContext>) => {
			logError("BOT_RUNTIME", err.error, {
				updateId: err.ctx.update.update_id,
				chatId: err.ctx.chat?.id,
				userId: err.ctx.from?.id,
			});
		});

		bot.start({
			onStart: async (botInfo: UserFromGetMe) => {
				await bot.api.setMyCommands(botCommands);
				logger.info(`Bot [${botInfo.username}] started`);
			},
		});
	} catch (error) {
		logError("APP_STARTUP", error);
		logger.warn("Application is exiting unexpectedly.");
		process.exit(1);
	}
}

main();
