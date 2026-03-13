import { db } from "../db/index.js";
import { tasksTable } from "../db/schema.js";
import type { CreateChatTaskInput } from "./types.js";

export async function enqueueChatTask(input: CreateChatTaskInput) {
  const now = Date.now();

  const [task] = await db
    .insert(tasksTable)
    .values({
      type: "chat",
      status: "pending",
      conversationId: input.conversationId,
      chatId: input.chatId,
      userId: input.userId,
      triggerTelegramMessageId: input.triggerTelegramMessageId,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return task;
}
