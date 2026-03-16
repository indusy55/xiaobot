import { index, int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const TASK_TYPES = ["chat"] as const;
const TASK_STATUSES = [
  "pending",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
] as const;

export const chatsTable = sqliteTable("chats", {
  id: text().primaryKey(),
  type: text().notNull(),
  title: text(),
  lastKnownUsername: text(),
  createdAt: int().notNull(),
  updatedAt: int().notNull(),
});

export const usersTable = sqliteTable("users", {
  id: text().primaryKey(),
  lastKnownUsername: text(),
  firstName: text(),
  lastName: text(),
  languageCode: text(),
  createdAt: int().notNull(),
  updatedAt: int().notNull(),
});

export const chatParticipantsTable = sqliteTable(
  "chat_participants",
  {
    chatId: text()
      .notNull()
      .references(() => chatsTable.id),
    userId: text()
      .notNull()
      .references(() => usersTable.id),
    observedUsername: text(),
    observedFirstName: text(),
    observedLastName: text(),
    observedLanguageCode: text(),
    isBot: int({ mode: "boolean" }).notNull().default(false),
    firstSeenAt: int().notNull(),
    lastSeenAt: int().notNull(),
    createdAt: int().notNull(),
    updatedAt: int().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.userId] }),
    index("chat_participants_user_idx").on(table.userId),
    index("chat_participants_last_seen_idx").on(table.chatId, table.lastSeenAt),
  ]
);

export const messagesTable = sqliteTable(
  "messages",
  {
    id: int().primaryKey({ autoIncrement: true }),
    conversationId: text().notNull(),
    chatId: text()
      .notNull()
      .references(() => chatsTable.id),
    userId: text().references(() => usersTable.id),
    chatType: text().notNull(),
    chatTitle: text(),
    threadId: int(),
    telegramMessageId: int(),
    telegramUpdateId: int(),
    replyToTelegramMessageId: int(),
    parentMessageId: int(),
    referenceMessageId: int(),
    role: text({ enum: ["user", "assistant", "system", "tool"] }).notNull(),
    contentType: text().notNull(),
    fromId: text(),
    fromUsername: text(),
    fromFirstName: text(),
    fromLastName: text(),
    fromLanguageCode: text(),
    textContent: text(),
    rawMessage: text().notNull(),
    aiModel: text(),
    promptTokens: int(),
    completionTokens: int(),
    totalTokens: int(),
    status: text({ enum: ["received", "sent", "error"] }).notNull(),
    errorMessage: text(),
    createdAt: int().notNull(),
  },
  (table) => [
    index("messages_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt
    ),
    index("messages_chat_created_at_idx").on(table.chatId, table.createdAt),
    index("messages_user_created_at_idx").on(table.userId, table.createdAt),
    index("messages_telegram_message_idx").on(table.chatId, table.telegramMessageId),
    index("messages_parent_message_idx").on(table.parentMessageId),
    index("messages_reference_message_idx").on(table.referenceMessageId),
  ]
);

export const tasksTable = sqliteTable(
  "tasks",
  {
    id: int().primaryKey({ autoIncrement: true }),
    type: text({ enum: TASK_TYPES }).notNull(),
    status: text({ enum: TASK_STATUSES }).notNull(),
    conversationId: text().notNull(),
    chatId: text()
      .notNull()
      .references(() => chatsTable.id),
    userId: text().references(() => usersTable.id),
    triggerTelegramMessageId: int(),
    payload: text(),
    contextSnapshot: text(),
    result: text(),
    errorMessage: text(),
    retryCount: int().notNull().default(0),
    cancelRequestedAt: int(),
    startedAt: int(),
    finishedAt: int(),
    createdAt: int().notNull(),
    updatedAt: int().notNull(),
  },
  (table) => [
    index("tasks_status_created_at_idx").on(table.status, table.createdAt),
    index("tasks_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt
    ),
    index("tasks_chat_created_at_idx").on(table.chatId, table.createdAt),
  ]
);

export const stickerSetsTable = sqliteTable(
  "sticker_sets",
  {
    name: text().primaryKey(),
    title: text().notNull(),
    stickerType: text().notNull(),
    createdByUserId: text().references(() => usersTable.id),
    createdAt: int().notNull(),
    updatedAt: int().notNull(),
  },
  (table) => [index("sticker_sets_updated_at_idx").on(table.updatedAt)]
);

export const stickersTable = sqliteTable(
  "stickers",
  {
    id: int().primaryKey({ autoIncrement: true }),
    setName: text()
      .notNull()
      .references(() => stickerSetsTable.name),
    fileId: text().notNull(),
    fileUniqueId: text().notNull(),
    emoji: text(),
    width: int(),
    height: int(),
    isAnimated: int({ mode: "boolean" }).notNull().default(false),
    isVideo: int({ mode: "boolean" }).notNull().default(false),
    createdAt: int().notNull(),
    updatedAt: int().notNull(),
  },
  (table) => [
    index("stickers_set_name_idx").on(table.setName),
    index("stickers_file_unique_id_idx").on(table.fileUniqueId),
    index("stickers_emoji_idx").on(table.emoji),
  ]
);
