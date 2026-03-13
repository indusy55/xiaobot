import { Bot } from "grammy";
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

		const bot = new Bot(cfg.BOT_TOKEN);
		const chatModel = createChatModel(cfg);
		const decisionModel = createDecisionModel(cfg);
		let taskWorker: TaskWorker;
		taskWorker = new TaskWorker({
			api: bot.api,
			chatModel,
			decisionModel,
			taskRuntime: {
				enqueueChatTask,
				requestCancelLatest: (scope) => taskWorker.requestCancelLatest(scope),
			},
		});

		setupMessagePersistenceMiddleware(bot);
		setupMessageLoggerMiddleware(bot);
		setupHandlers(bot, taskWorker);
		taskWorker.startPolling();

		bot.catch((err) => {
			logError("BOT_RUNTIME", err.error, {
				updateId: err.ctx.update.update_id,
				chatId: err.ctx.chat?.id,
				userId: err.ctx.from?.id,
			});
		});

		bot.start({
			onStart: (botInfo) => {
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
