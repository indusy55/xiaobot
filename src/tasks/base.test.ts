import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { TaskDependencies, TaskRecord } from "./types.js";

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

  const [{ db }, { BaseTask }] = await Promise.all([
    import("../db/index.js"),
    import("./base.js"),
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

  await db.run(`
    create table if not exists tasks (
      id integer primary key autoincrement,
      type text not null,
      status text not null,
      conversationId text not null,
      chatId text not null,
      userId text,
      triggerTelegramMessageId integer,
      payload text,
      contextSnapshot text,
      result text,
      errorMessage text,
      retryCount integer not null default 0,
      workerOwner text,
      leaseExpiresAt integer,
      cancelRequestedAt integer,
      startedAt integer,
      finishedAt integer,
      createdAt integer not null,
      updatedAt integer not null
    )
  `);

  class TestTask extends BaseTask {
    protected async execute() {
      return null;
    }

    async exposeLoadContext(limit = 20) {
      return this.loadContext(limit);
    }

    async exposeLoadRecentConversationTaskSnapshots(limit = 5) {
      return this.loadRecentConversationTaskSnapshots(limit);
    }

    async exposeReload() {
      return this.reload();
    }

    async exposeSaveContextSnapshot(snapshot: unknown) {
      return this.saveContextSnapshot(snapshot);
    }
  }

  return { db, TestTask };
}

function createDependencies(): TaskDependencies {
  return {
    api: {} as never,
    chatModel: {} as never,
    decisionModel: {} as never,
    taskRuntime: {
      enqueueChatTask: async () => null,
      requestCancelLatest: async () => ({ result: "not_found" as const, task: null }),
    },
    taskTimeoutMs: 60_000,
    chatDecisionTimeoutMs: 10_000,
    chatContextLimit: 30,
    chatContextSummaryLimit: 10,
    chatMediaContextLimit: 3,
    telegramMediaCacheDir: "data/media-cache",
  };
}

afterEach(async () => {
  vi.restoreAllMocks();

  if (databaseFile != null) {
    await rm(databaseFile, { force: true }).catch(() => undefined);
    databaseFile = null;
  }
});

describe("BaseTask branch-aware loading", () => {
  it("loads anchor-family messages for a branch conversation", async () => {
    databaseFile = `base-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, TestTask } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);

    await db.run(`
      insert into messages (
        conversationId, chatId, chatType, telegramMessageId, replyToTelegramMessageId,
        parentMessageId, referenceMessageId, role, contentType, textContent, rawMessage,
        status, createdAt
      ) values
        ('chat:1:anchor:101', 'chat-1', 'group', 101, null, null, null, 'user', 'text', 'anchor', '{}', 'received', 1),
        ('chat:1:anchor:101', 'chat-1', 'group', 102, null, 1, 1, 'assistant', 'text', 'shared trunk', '{}', 'sent', 2),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 105, 102, 2, 1, 'user', 'text', 'branch root', '{}', 'received', 3),
        ('chat:1:anchor:101:branch:105', 'chat-1', 'group', 106, null, 3, 1, 'assistant', 'text', 'branch answer', '{}', 'sent', 4)
    `);

    await db.run(`
      insert into tasks (
        id, type, status, conversationId, chatId, triggerTelegramMessageId,
        retryCount, workerOwner, leaseExpiresAt, createdAt, updatedAt
      ) values (
        1, 'chat', 'pending', 'chat:1:anchor:101:branch:105', 'chat-1', 106,
        0, 'worker-test', 99999, 10, 10
      )
    `);

    const taskRecord: TaskRecord = {
      id: 1,
      type: "chat",
      status: "pending",
      conversationId: "chat:1:anchor:101:branch:105",
      chatId: "chat-1",
      userId: null,
      triggerTelegramMessageId: 106,
      payload: null,
      contextSnapshot: null,
      result: null,
      errorMessage: null,
      retryCount: 0,
      workerOwner: "worker-test",
      leaseExpiresAt: 99_999,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: 10,
      updatedAt: 10,
    };

    const task = new TestTask(taskRecord, createDependencies());
    const context = await task.exposeLoadContext(10);

    expect(context.map((message) => message.telegramMessageId)).toEqual([
      101,
      102,
      105,
      106,
    ]);
  });

  it("includes anchor-family snapshots for branch reuse", async () => {
    databaseFile = `base-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, TestTask } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);

    await db.run(`
      insert into tasks (
        id, type, status, conversationId, chatId, triggerTelegramMessageId,
        contextSnapshot, retryCount, workerOwner, leaseExpiresAt, createdAt, updatedAt
      ) values
        (1, 'chat', 'completed', 'chat:1:anchor:101', 'chat-1', 102, '{"toolObservations":[]}', 0, null, null, 5, 5),
        (2, 'chat', 'completed', 'chat:1:anchor:101:branch:105', 'chat-1', 106, '{"toolObservations":[]}', 0, null, null, 6, 6),
        (3, 'chat', 'pending', 'chat:1:anchor:101:branch:105', 'chat-1', 107, null, 0, 'worker-test', 99999, 10, 10)
    `);

    const taskRecord: TaskRecord = {
      id: 3,
      type: "chat",
      status: "pending",
      conversationId: "chat:1:anchor:101:branch:105",
      chatId: "chat-1",
      userId: null,
      triggerTelegramMessageId: 107,
      payload: null,
      contextSnapshot: null,
      result: null,
      errorMessage: null,
      retryCount: 0,
      workerOwner: "worker-test",
      leaseExpiresAt: 99_999,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: 10,
      updatedAt: 10,
    };

    const task = new TestTask(taskRecord, createDependencies());
    const snapshots = await task.exposeLoadRecentConversationTaskSnapshots(10);

    expect(snapshots.map((snapshot) => snapshot.id)).toEqual([2, 1]);
  });

  it("rejects further reloads after lease ownership changes", async () => {
    databaseFile = `base-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, TestTask } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);

    await db.run(`
      insert into tasks (
        id, type, status, conversationId, chatId, triggerTelegramMessageId,
        retryCount, workerOwner, leaseExpiresAt, createdAt, updatedAt
      ) values (
        1, 'chat', 'running', 'chat:1', 'chat-1', null,
        0, 'worker-a', 99999, 10, 10
      )
    `);

    const task = new TestTask(
      {
        id: 1,
        type: "chat",
        status: "running",
        conversationId: "chat:1",
        chatId: "chat-1",
        userId: null,
        triggerTelegramMessageId: null,
        payload: null,
        contextSnapshot: null,
        result: null,
        errorMessage: null,
        retryCount: 0,
        workerOwner: "worker-a",
        leaseExpiresAt: 99_999,
        cancelRequestedAt: null,
        startedAt: 10,
        finishedAt: null,
        createdAt: 10,
        updatedAt: 10,
      },
      createDependencies()
    );

    await db.run(`
      update tasks
      set workerOwner = 'worker-b', leaseExpiresAt = 123456, updatedAt = 11
      where id = 1
    `);

    await expect(task.exposeReload()).rejects.toThrow(
      "lease ownership changed from worker-a to worker-b"
    );
    await expect(
      task.exposeSaveContextSnapshot({ ok: true })
    ).rejects.toThrow("lease ownership changed from worker-a to worker-b");
  });

  it("excludes same-second messages that were inserted after the trigger row", async () => {
    databaseFile = `base-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.db`;
    const { db, TestTask } = await loadModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'group', 1, 1)
    `);

    await db.run(`
      insert into messages (
        conversationId, chatId, chatType, telegramMessageId, replyToTelegramMessageId,
        parentMessageId, referenceMessageId, role, contentType, textContent,
        rawMessage, status, createdAt
      ) values
        ('chat:1', 'chat-1', 'group', 101, null, null, null, 'user', 'text', 'before', '{}', 'received', 1000),
        ('chat:1', 'chat-1', 'group', 102, 101, 1, 1, 'user', 'text', 'trigger', '{}', 'received', 1000),
        ('chat:1', 'chat-1', 'group', 103, 102, 2, 1, 'assistant', 'text', 'future-same-second', '{}', 'sent', 1000)
    `);

    await db.run(`
      insert into tasks (
        id, type, status, conversationId, chatId, triggerTelegramMessageId,
        retryCount, workerOwner, leaseExpiresAt, createdAt, updatedAt
      ) values (
        1, 'chat', 'pending', 'chat:1', 'chat-1', 102,
        0, 'worker-test', 99999, 10, 10
      )
    `);

    const task = new TestTask(
      {
        id: 1,
        type: "chat",
        status: "pending",
        conversationId: "chat:1",
        chatId: "chat-1",
        userId: null,
        triggerTelegramMessageId: 102,
        payload: null,
        contextSnapshot: null,
        result: null,
        errorMessage: null,
        retryCount: 0,
        workerOwner: "worker-test",
        leaseExpiresAt: 99_999,
        cancelRequestedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: 10,
        updatedAt: 10,
      },
      createDependencies()
    );

    const context = await task.exposeLoadContext(10);

    expect(context.map((message) => message.telegramMessageId)).toEqual([
      101,
      102,
    ]);
  });
});
