import type { Bot } from "grammy";

export function setupPingHandler(bot: Bot) {
  bot.command('ping', (ctx) => {
    ctx.reply('pong🏓')
  })
}
