import type { AppBot } from "../types.js";

export function setupPingHandler(bot: AppBot) {
  bot.command('ping', (ctx) => {
    ctx.reply('pong🏓')
  })
}
