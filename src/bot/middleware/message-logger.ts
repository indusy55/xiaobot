import type { Bot } from "grammy";
import { logger } from "../../infra/logger/index.js";

export function setupMessageLoggerMiddleware(bot: Bot) {
  // Text messages
  bot.on("message:text", (ctx, next) => {
    const user = ctx.from;
    const chat = ctx.chat;
    const location = chat?.type === 'private' ? 'DM' : chat?.title || 'Group';
    logger.info(`💬 ${user?.username || user?.first_name} [${location}]: ${ctx.message.text}`);
    return next();
  });

  // Photos
  bot.on("message:photo", (ctx, next) => {
    const user = ctx.from;
    const caption = ctx.message.caption ? `: ${ctx.message.caption}` : '';
    logger.info(`📸 ${user?.username || user?.first_name} sent a photo${caption}`);
    return next();
  });

  // Stickers
  bot.on("message:sticker", (ctx, next) => {
    const user = ctx.from;
    const emoji = ctx.message.sticker.emoji || '';
    logger.info(`🎨 ${user?.username || user?.first_name} sent a sticker ${emoji}`);
    return next();
  });

  // Documents/Files
  bot.on("message:document", (ctx, next) => {
    const user = ctx.from;
    const fileName = ctx.message.document.file_name;
    logger.info(`📎 ${user?.username || user?.first_name} sent a file: ${fileName}`);
    return next();
  });

  // Videos
  bot.on("message:video", (ctx, next) => {
    const user = ctx.from;
    logger.info(`🎥 ${user?.username || user?.first_name} sent a video`);
    return next();
  });

  // Audio
  bot.on("message:audio", (ctx, next) => {
    const user = ctx.from;
    logger.info(`🎵 ${user?.username || user?.first_name} sent audio`);
    return next();
  });

  // Voice messages
  bot.on("message:voice", (ctx, next) => {
    const user = ctx.from;
    logger.info(`🎤 ${user?.username || user?.first_name} sent a voice message`);
    return next();
  });

  // Location
  bot.on("message:location", (ctx, next) => {
    const user = ctx.from;
    logger.info(`📍 ${user?.username || user?.first_name} shared a location`);
    return next();
  });

  // New members joining
  bot.on("message:new_chat_members", (ctx, next) => {
    const chat = ctx.chat;
    const newMembers = ctx.message.new_chat_members
      .map(m => m.username || m.first_name)
      .join(', ');
    logger.info(`👋 New members joined ${chat?.title || 'group'}: ${newMembers}`);
    return next();
  });

  // Members leaving
  bot.on("message:left_chat_member", (ctx, next) => {
    const chat = ctx.chat;
    const leftUser = ctx.message.left_chat_member.username || ctx.message.left_chat_member.first_name;
    logger.info(`👋 Member left ${chat?.title || 'group'}: ${leftUser}`);
    return next();
  });

  // Callback queries (button clicks)
  bot.on("callback_query:data", (ctx, next) => {
    const user = ctx.from;
    logger.info(`🖱️ ${user?.username || user?.first_name} clicked button: ${ctx.callbackQuery.data}`);
    return next();
  });

  // Inline queries
  bot.on("inline_query", (ctx, next) => {
    const user = ctx.from;
    const query = ctx.inlineQuery.query || 'empty query';
    logger.info(`🔍 ${user?.username || user?.first_name} inline query: ${query}`);
    return next();
  });

  // Polls
  bot.on("message:poll", (ctx, next) => {
    const user = ctx.from;
    logger.info(`📊 ${user?.username || user?.first_name} created a poll: ${ctx.message.poll.question}`);
    return next();
  });

  // Video notes (circular videos)
  bot.on("message:video_note", (ctx, next) => {
    const user = ctx.from;
    logger.info(`📹 ${user?.username || user?.first_name} sent a video note`);
    return next();
  });

  // Contacts
  bot.on("message:contact", (ctx, next) => {
    const user = ctx.from;
    logger.info(`📇 ${user?.username || user?.first_name} shared a contact`);
    return next();
  });

  // Dice
  bot.on("message:dice", (ctx, next) => {
    const user = ctx.from;
    logger.info(`🎲 ${user?.username || user?.first_name} rolled a dice: ${ctx.message.dice.value}`);
    return next();
  });

  // Venue
  bot.on("message:venue", (ctx, next) => {
    const user = ctx.from;
    logger.info(`🏢 ${user?.username || user?.first_name} shared a venue`);
    return next();
  });

  // Successful payment
  bot.on("message:successful_payment", (ctx, next) => {
    const user = ctx.from;
    logger.info(`💰 ${user?.username || user?.first_name} made a payment`);
    return next();
  });

  // Pinned message
  bot.on("message:pinned_message", (ctx, next) => {
    const user = ctx.from;
    logger.info(`📌 ${user?.username || user?.first_name} pinned a message`);
    return next();
  });

  // Migrate to supergroup
  bot.on("message:migrate_to_chat_id", (ctx, next) => {
    logger.info(`🔄 Group migrated to supergroup: ${ctx.message.migrate_to_chat_id}`);
    return next();
  });
}
