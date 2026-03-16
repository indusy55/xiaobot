import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { messagesTable } from "../db/schema.js";

function buildThreadScopeCondition(threadId?: number) {
  return threadId == null
    ? isNull(messagesTable.threadId)
    : eq(messagesTable.threadId, threadId);
}

export async function updatePersistedMessageText(options: {
  chatId: string;
  telegramMessageId: number;
  textContent: string;
  threadId?: number;
}) {
  const { chatId, telegramMessageId, textContent, threadId } = options;

  await db
    .update(messagesTable)
    .set({
      textContent,
    })
    .where(
      and(
        eq(messagesTable.chatId, chatId),
        eq(messagesTable.telegramMessageId, telegramMessageId),
        buildThreadScopeCondition(threadId)
      )
    );
}
