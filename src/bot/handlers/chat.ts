import {
  assignConversationIdToMessages,
  inspectMessageHistory,
} from "../conversation-store.js";
import {
  buildAnchoredConversationId,
  buildConversationId,
} from "../conversation.js";
import { logError } from "../../infra/error/index.js";
import { enqueueChatTask } from "../../tasks/index.js";
import type { AppBot } from "../types.js";

type MessageEntity = {
  type: string;
  offset: number;
  length: number;
  user?: { id: number };
};

type SupportedChatMessage = {
  text?: string;
  caption?: string;
  entities?: readonly MessageEntity[];
  caption_entities?: readonly MessageEntity[];
  photo?: unknown[];
  sticker?: { emoji?: string };
  reply_to_message?: {
    from?: { id?: number };
    message_id?: number;
  };
  message_id: number;
  message_thread_id?: number;
};

function getSupportedMessageText(message: SupportedChatMessage) {
  if (typeof message.text === "string") {
    return message.text;
  }

  if (typeof message.caption === "string") {
    return message.caption;
  }

  if (message.sticker?.emoji) {
    return message.sticker.emoji;
  }

  return "";
}

function getSupportedMessageEntities(message: SupportedChatMessage) {
  if (Array.isArray(message.entities)) {
    return message.entities;
  }

  if (Array.isArray(message.caption_entities)) {
    return message.caption_entities;
  }

  return [];
}

function getSupportedMessageContentType(message: SupportedChatMessage) {
  if (typeof message.text === "string") {
    return "text";
  }

  if (Array.isArray(message.photo)) {
    return "photo";
  }

  if (message.sticker) {
    return "sticker";
  }

  return null;
}

function shouldHandleChatMessage(
  bot: AppBot,
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
    if (entity.type === "mention") {
      const mentionText = messageText.slice(entity.offset, entity.offset + entity.length);
      return mentionText.toLowerCase() === `@${botInfo.username.toLowerCase()}`;
    }

    if (entity.type === "text_mention") {
      return entity.user?.id === botInfo.id;
    }

    return false;
  });
}

function hasDirectBotMention(
  bot: AppBot,
  messageText: string,
  entities: readonly MessageEntity[] = []
) {
  const botInfo = bot.botInfo;
  if (!botInfo) {
    return false;
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

function stripBotMentions(
  bot: AppBot,
  text: string,
  entities: readonly MessageEntity[] = []
) {
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

async function resolveChatConversation(options: {
  chatId: string;
  chatType: string;
  threadId: number | undefined;
  telegramMessageId: number;
  replyToTelegramMessageId: number | undefined;
  startNewConversation?: boolean;
  anchorConversationToMessageId?: number;
}) {
  const {
    chatId,
    chatType,
    threadId,
    telegramMessageId,
    replyToTelegramMessageId,
    startNewConversation,
    anchorConversationToMessageId,
  } = options;
  const baseConversationId = buildConversationId(chatId, chatType, threadId);

  if (anchorConversationToMessageId != null) {
    return {
      conversationId: buildAnchoredConversationId(
        baseConversationId,
        anchorConversationToMessageId
      ),
      messageIdsToAssign: [telegramMessageId],
    };
  }

  if (startNewConversation) {
    return {
      conversationId: buildAnchoredConversationId(baseConversationId, telegramMessageId),
      messageIdsToAssign: [telegramMessageId],
    };
  }

  if (replyToTelegramMessageId == null) {
    return {
      conversationId: baseConversationId,
      messageIdsToAssign: [telegramMessageId],
    };
  }

  const history = await inspectMessageHistory({
    chatId,
    telegramMessageId: replyToTelegramMessageId,
    baseConversationId,
    ...(threadId == null ? {} : { threadId }),
  });

  const conversationId =
    history.conversationId ??
    buildAnchoredConversationId(baseConversationId, replyToTelegramMessageId);

  return {
    conversationId,
    messageIdsToAssign: [...history.messageIds, telegramMessageId],
  };
}

export function setupChatHandler(bot: AppBot) {
  bot.on("message", async (ctx) => {
    const message = ctx.msg as SupportedChatMessage;
    const contentType = getSupportedMessageContentType(message);
    if (contentType == null) {
      return;
    }

    const messageText = getSupportedMessageText(message);
    const messageEntities = getSupportedMessageEntities(message);
    const entity = messageEntities[0];
    if (entity?.type === "bot_command" && entity.offset === 0) {
      return;
    }

    const shouldHandle = shouldHandleChatMessage(
      bot,
      messageText,
      ctx.chat.type,
      messageEntities,
      message.reply_to_message?.from?.id
    );
    if (!shouldHandle) {
      return;
    }

    const chatId = String(ctx.chat.id);
    const threadId = getThreadId(message);
    const replyToTelegramMessageId =
      typeof message.reply_to_message?.message_id === "number"
        ? message.reply_to_message.message_id
        : undefined;
    const directBotMention =
      ctx.chat.type !== "private" &&
      hasDirectBotMention(bot, messageText, messageEntities);
    const userInput =
      ctx.chat.type === "private"
        ? messageText.trim()
        : stripBotMentions(bot, messageText, messageEntities);
    const startNewConversation =
      ctx.chat.type !== "private" &&
      replyToTelegramMessageId == null &&
      directBotMention;
    const anchorConversationToMessageId =
      ctx.chat.type !== "private" &&
      directBotMention &&
      replyToTelegramMessageId != null
        ? replyToTelegramMessageId
        : undefined;

    try {
      const { conversationId, messageIdsToAssign } = await resolveChatConversation({
        chatId,
        chatType: ctx.chat.type,
        threadId,
        telegramMessageId: message.message_id,
        replyToTelegramMessageId,
        ...(anchorConversationToMessageId == null
          ? {}
          : { anchorConversationToMessageId }),
        ...(startNewConversation ? { startNewConversation: true } : {}),
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
        triggerTelegramMessageId: message.message_id,
        payload: {
          text: messageText,
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
