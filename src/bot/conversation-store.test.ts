import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

const REQUIRED_ENV = {
  BOT_TOKEN: "test-bot-token",
  ADMIN_ID: "1",
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_MODEL: "test-model",
};

let databaseFile: string | null = null;

async function loadModules(databaseUrl: string) {
  process.env = {
    ...process.env,
    ...REQUIRED_ENV,
    DATABASE_URL: databaseUrl,
  };

  vi.resetModules();

  const [{ db }, store] = await Promise.all([
    import("../db/index.js"),
    import("./conversation-store.js"),
  ]);

  await db.run(`
    create table if not exists chats (
      id text primary key,
      type text,
      title text,
      lastKnownUsername text,
      createdAt integer not null,
      updatedAt integer not null
    )
  `);

  await db.run(`
    create table if not exists messages (
      id integer primary key autoincrement,
      conversationId text not null,
      chatId text not null,
      userId text,
      chatType text not null,
      chatTitle text,
      threadId integer,
      telegramMessageId integer,
      telegramUpdateId integer,
      replyToTelegramMessageId integer,
      parentMessageId integer,
      referenceMessageId integer,
      role text not null,
      contentType text not null,
      fromId text,
      fromUsername text,
      fromFirstName text,
      fromLastName text,
      fromLanguageCode text,
      textContent text,
      rawMessage text not null,
      aiModel text,
      promptTokens integer,
      completionTokens integer,
      totalTokens integer,
      status text not null,
      errorMessage text,
      createdAt integer not null
    )
  `);

  return { db, store };
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (databaseFile != null) {
    await rm(databaseFile, { force: true }).catch(() => undefined);
    databaseFile = null;
  }
});

describe("conversation-store branch references", () => {
  it("resolves the earliest branch anchor for a replied message", async () => {
    databaseFile = `conversation-store-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, store } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);
    await db.run(`
      insert into messages (
        conversationId, chatId, chatType, telegramMessageId, parentMessageId,
        referenceMessageId, role, contentType, rawMessage, status, createdAt
      ) values
        ('chat:1:anchor:101', 'chat-1', 'group', 101, null, null, 'user', 'text', '{}', 'received', 1),
        ('chat:1:anchor:101', 'chat-1', 'group', 102, 1, 1, 'assistant', 'text', '{}', 'sent', 2),
        ('chat:1:anchor:101', 'chat-1', 'group', 103, 2, 1, 'user', 'text', '{}', 'received', 3)
    `);

    const referenceTelegramMessageId =
      await store.resolveBranchReferenceTelegramMessageId({
        chatId: "chat-1",
        telegramMessageId: 103,
      });

    expect(referenceTelegramMessageId).toBe(101);
  });

  it("keeps following an explicit branch when replying inside that branch", async () => {
    databaseFile = `conversation-store-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, store } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);
    await db.run(`
      insert into messages (
        conversationId, chatId, chatType, telegramMessageId, replyToTelegramMessageId,
        parentMessageId, referenceMessageId, role, contentType, rawMessage, status, createdAt
      ) values
        ('chat:1:anchor:101', 'chat-1', 'group', 101, null, null, null, 'user', 'text', '{}', 'received', 1),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 105, 101, 1, 1, 'assistant', 'text', '{}', 'sent', 2),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 106, 105, 2, 1, 'user', 'text', '{}', 'received', 3),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 107, 106, 3, 1, 'assistant', 'text', '{}', 'sent', 4)
    `);

    const conversationId = await store.resolveConversationIdFromMessageHistory({
      chatId: "chat-1",
      telegramMessageId: 106,
      baseConversationId: "chat:1",
    });

    expect(conversationId).toBe("chat:1:anchor:101:branch:105");
  });

  it("does not silently reuse the latest branch when replying to the shared anchor", async () => {
    databaseFile = `conversation-store-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, store } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);
    await db.run(`
      insert into messages (
        conversationId, chatId, chatType, telegramMessageId, replyToTelegramMessageId,
        parentMessageId, referenceMessageId, role, contentType, rawMessage, status, createdAt
      ) values
        ('chat:1:anchor:101', 'chat-1', 'group', 101, null, null, null, 'user', 'text', '{}', 'received', 1),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 105, 101, 1, 1, 'assistant', 'text', '{}', 'sent', 2),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 106, 105, 2, 1, 'user', 'text', '{}', 'received', 3),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 107, 106, 3, 1, 'assistant', 'text', '{}', 'sent', 4)
    `);

    const conversationId = await store.resolveConversationIdFromMessageHistory({
      chatId: "chat-1",
      telegramMessageId: 101,
      baseConversationId: "chat:1",
    });

    expect(conversationId).toBe("chat:1:anchor:101");
  });
});
