import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { messagesTable } from "../db/schema.js";

interface StoredMessageConversation {
  id: number;
  conversationId: string;
  telegramMessageId: number | null;
  replyToTelegramMessageId: number | null;
}

interface MessageHistoryInspection {
  conversationId: string | null;
  messageIds: number[];
}

function buildThreadScopeCondition(threadId?: number) {
  return threadId == null
    ? isNull(messagesTable.threadId)
    : eq(messagesTable.threadId, threadId);
}

async function findMessageByTelegramMessageId(
  chatId: string,
  telegramMessageId: number,
  threadId?: number
) {
  const [message] = await db
    .select({
      id: messagesTable.id,
      conversationId: messagesTable.conversationId,
      telegramMessageId: messagesTable.telegramMessageId,
      replyToTelegramMessageId: messagesTable.replyToTelegramMessageId,
    })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.chatId, chatId),
        eq(messagesTable.telegramMessageId, telegramMessageId),
        buildThreadScopeCondition(threadId)
      )
    )
    .limit(1);

  return message as StoredMessageConversation | undefined;
}

export async function assignConversationIdToMessage(
  chatId: string,
  telegramMessageId: number,
  conversationId: string,
  threadId?: number
) {
  await db
    .update(messagesTable)
    .set({
      conversationId,
    })
    .where(
      and(
        eq(messagesTable.chatId, chatId),
        eq(messagesTable.telegramMessageId, telegramMessageId),
        buildThreadScopeCondition(threadId)
      )
    );
}

export async function assignConversationIdToMessages(
  chatId: string,
  telegramMessageIds: number[],
  conversationId: string,
  threadId?: number
) {
  const uniqueMessageIds = [...new Set(telegramMessageIds)];
  if (uniqueMessageIds.length === 0) {
    return;
  }

  await db
    .update(messagesTable)
    .set({
      conversationId,
    })
    .where(
      and(
        eq(messagesTable.chatId, chatId),
        inArray(messagesTable.telegramMessageId, uniqueMessageIds),
        buildThreadScopeCondition(threadId)
      )
    );
}

export async function resolveConversationIdFromMessageHistory(options: {
  chatId: string;
  threadId?: number;
  telegramMessageId: number;
  baseConversationId: string;
  maxDepth?: number;
}) {
  const { chatId, threadId, telegramMessageId, baseConversationId, maxDepth = 20 } =
    options;
  const inspection = await inspectMessageHistory({
    chatId,
    telegramMessageId,
    baseConversationId,
    maxDepth,
    ...(threadId == null ? {} : { threadId }),
  });

  return inspection.conversationId;
}

export async function inspectMessageHistory(options: {
  chatId: string;
  threadId?: number;
  telegramMessageId: number;
  baseConversationId: string;
  maxDepth?: number;
}): Promise<MessageHistoryInspection> {
  const { chatId, threadId, telegramMessageId, baseConversationId, maxDepth = 20 } =
    options;
  const visited = new Set<number>();
  const messageIds: number[] = [];

  let currentMessageId: number | null = telegramMessageId;

  while (
    typeof currentMessageId === "number" &&
    !visited.has(currentMessageId) &&
    visited.size < maxDepth
  ) {
    visited.add(currentMessageId);
    messageIds.push(currentMessageId);

    const message = await findMessageByTelegramMessageId(
      chatId,
      currentMessageId,
      threadId
    );
    if (!message) {
      return {
        conversationId: null,
        messageIds,
      };
    }

    if (message.conversationId !== baseConversationId) {
      return {
        conversationId: message.conversationId,
        messageIds,
      };
    }

    currentMessageId = message.replyToTelegramMessageId;
  }

  return {
    conversationId: null,
    messageIds,
  };
}
