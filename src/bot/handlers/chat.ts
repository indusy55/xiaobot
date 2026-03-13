import type { Bot } from "grammy";
import {
  assignConversationIdToMessages,
  resolveConversationIdFromMessageHistory,
} from "../conversation-store.js";
import {
  buildAnchoredConversationId,
  buildConversationId,
} from "../conversation.js";
import { logError } from "../../infra/error/index.js";
import { enqueueChatTask } from "../../tasks/index.js";

type MessageEntity = {
  type: string;
  offset: number;
  length: number;
  user?: { id: number };
};

function shouldHandleChatMessage(
  bot: Bot,
  messageText: string,
  chatType: string,
  entities: readonly MessageEntity[] = [],
  replyToUserId?: number
) {
  if (chatType === "private") {
    return true;
  }

  const botInfo = bot.botInfo;
  if (!botInfo) {
    return false;
  }

  if (replyToUserId === botInfo.id) {
    return true;
  }

  return entities.some((entity) => {
    if (entity.type === "text_mention") {
      return entity.user?.id === botInfo.id;
    }

    if (entity.type !== "mention") {
      return false;
    }

    const mentionText = messageText.slice(entity.offset, entity.offset + entity.length);
    return mentionText.toLowerCase() === `@${botInfo.username.toLowerCase()}`;
  });
}

function stripBotMentions(bot: Bot, text: string, entities: readonly MessageEntity[] = []) {
  const botInfo = bot.botInfo;
  if (!botInfo || text.length === 0) {
    return text.trim();
  }

  const botUsername = botInfo.username.toLowerCase();
  const mentionRanges = entities
    .filter((entity) => {
      if (entity.type === "text_mention") {
        return entity.user?.id === botInfo.id;
      }

      if (entity.type !== "mention") {
        return false;
      }

      const mentionText = text.slice(entity.offset, entity.offset + entity.length);
      return mentionText.toLowerCase() === `@${botUsername}`;
    })
    .sort((left, right) => right.offset - left.offset);

  let nextText = text;
  for (const entity of mentionRanges) {
    nextText =
      nextText.slice(0, entity.offset) + nextText.slice(entity.offset + entity.length);
  }

  return nextText.replace(/\s+/g, " ").trim();
}

function getThreadId(message: { message_thread_id?: number }) {
  return typeof message.message_thread_id === "number"
    ? message.message_thread_id
    : undefined;
}

function getCommandInput(text: string, command: string) {
  const commandPattern = new RegExp(`^/${command}(?:@\\S+)?\\s*`, "i");
  return text.replace(commandPattern, "").trim();
}

async function resolveChatConversation(options: {
  chatId: string;
  chatType: string;
  threadId: number | undefined;
  telegramMessageId: number;
  replyToTelegramMessageId: number | undefined;
}) {
  const {
    chatId,
    chatType,
    threadId,
    telegramMessageId,
    replyToTelegramMessageId,
  } = options;
  const baseConversationId = buildConversationId(chatId, chatType, threadId);

  if (replyToTelegramMessageId == null) {
    return {
      conversationId: baseConversationId,
      messageIdsToAssign: [telegramMessageId],
    };
  }

  const existingConversationId = await resolveConversationIdFromMessageHistory({
    chatId,
    telegramMessageId: replyToTelegramMessageId,
    baseConversationId,
    ...(threadId == null ? {} : { threadId }),
  });

  const conversationId =
    existingConversationId ??
    buildAnchoredConversationId(baseConversationId, replyToTelegramMessageId);

  return {
    conversationId,
    messageIdsToAssign: [replyToTelegramMessageId, telegramMessageId],
  };
}

export function setupChatHandler(bot: Bot) {
  bot.command("chat", async (ctx) => {
    const userInput = getCommandInput(ctx.msg.text, "chat");
    if (!userInput) {
      await ctx.reply("Please provide a message after /chat.");
      return;
    }

    const chatId = String(ctx.chat.id);
    const threadId = getThreadId(ctx.msg);
    const baseConversationId = buildConversationId(chatId, ctx.chat.type, threadId);
    const conversationId = buildAnchoredConversationId(
      baseConversationId,
      ctx.msg.message_id
    );

    try {
      await assignConversationIdToMessages(
        chatId,
        [ctx.msg.message_id],
        conversationId,
        threadId
      );

      await enqueueChatTask({
        conversationId,
        chatId,
        triggerTelegramMessageId: ctx.msg.message_id,
        payload: {
          text: ctx.msg.text,
          userInput,
          ...(threadId == null ? {} : { threadId }),
          allowTaskActions: true,
          updateId: ctx.update.update_id,
        },
        ...(ctx.from ? { userId: String(ctx.from.id) } : {}),
      });
    } catch (error) {
      logError("CHAT_TASK_ENQUEUE", error, {
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        updateId: ctx.update.update_id,
      });
      await ctx.reply("Failed to queue task.");
    }
  });

  bot.on("message:text", async (ctx) => {
    const entity = ctx.msg.entities?.[0];
    if (entity?.type === "bot_command" && entity.offset === 0) {
      return;
    }

    const shouldHandle = shouldHandleChatMessage(
      bot,
      ctx.msg.text,
      ctx.chat.type,
      ctx.msg.entities,
      ctx.msg.reply_to_message?.from?.id
    );
    if (!shouldHandle) {
      return;
    }

    const chatId = String(ctx.chat.id);
    const threadId = getThreadId(ctx.msg);
    const replyToTelegramMessageId =
      typeof ctx.msg.reply_to_message?.message_id === "number"
        ? ctx.msg.reply_to_message.message_id
        : undefined;
    const userInput =
      ctx.chat.type === "private"
        ? ctx.msg.text.trim()
        : stripBotMentions(bot, ctx.msg.text, ctx.msg.entities);

    try {
      const { conversationId, messageIdsToAssign } = await resolveChatConversation({
        chatId,
        chatType: ctx.chat.type,
        threadId,
        telegramMessageId: ctx.msg.message_id,
        replyToTelegramMessageId,
      });

      await assignConversationIdToMessages(
        chatId,
        messageIdsToAssign,
        conversationId,
        threadId
      );

      await enqueueChatTask({
        conversationId,
        chatId,
        triggerTelegramMessageId: ctx.msg.message_id,
        payload: {
          text: ctx.msg.text,
          userInput,
          ...(threadId == null ? {} : { threadId }),
          allowTaskActions: true,
          updateId: ctx.update.update_id,
        },
        ...(ctx.from ? { userId: String(ctx.from.id) } : {}),
      });
    } catch (error) {
      logError("CHAT_TASK_ENQUEUE", error, {
        chatId: ctx.chat.id,
        userId: ctx.from?.id,
        updateId: ctx.update.update_id,
      });
      await ctx.reply("Failed to queue task.");
    }
  });
}
