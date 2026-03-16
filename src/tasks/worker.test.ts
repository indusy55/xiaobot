import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

const REQUIRED_ENV = {
  BOT_TOKEN: "test-bot-token",
  ADMIN_ID: "1",
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_MODEL: "test-model",
};

type TestModules = {
  db: {
    run: (query: string) => Promise<unknown>;
    all: <T = unknown>(query: string) => Promise<T[]>;
  };
  TaskWorker: typeof import("./worker.js").TaskWorker;
};

async function loadWorkerTestModules(databaseUrl: string): Promise<TestModules> {
  process.env = {
    ...process.env,
    ...REQUIRED_ENV,
    DATABASE_URL: databaseUrl,
  };

  vi.resetModules();

  const [{ db }, { TaskWorker }] = await Promise.all([
    import("../db/index.js"),
    import("./worker.js"),
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

  return {
    db: {
      run: (query) => db.run(query),
      all: (query) => db.all(query),
    },
    TaskWorker,
  };
}

function createTestDependencies() {
  return {
    api: {} as never,
    chatModel: {} as never,
    decisionModel: {} as never,
    taskRuntime: {
      enqueueChatTask: async () => null,
      requestCancelLatest: async () => ({ result: "not_found" as const, task: null }),
    },
    taskTimeoutMs: 1_000,
    chatDecisionTimeoutMs: 1_000,
    chatContextLimit: 30,
    chatContextSummaryLimit: 10,
    chatMediaContextLimit: 3,
    telegramMediaCacheDir: "data/media-cache",
  };
}

let databaseFile: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();

  if (databaseFile != null) {
    await rm(databaseFile, { force: true }).catch(() => undefined);
    databaseFile = null;
  }
});

describe("TaskWorker claimNextPendingTask", () => {
  it("claims a pending task at most once under concurrent attempts", async () => {
    databaseFile = `worker-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
    const { db, TaskWorker } = await loadWorkerTestModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'private', 1, 1)
    `);
    await db.run(`
      insert into tasks (
        type, status, conversationId, chatId, retryCount,
        workerOwner, leaseExpiresAt, createdAt, updatedAt
      )
      values (
        'chat', 'pending', 'conv-1', 'chat-1', 0, null, null, 1, 1
      )
    `);

    const worker = new TaskWorker(createTestDependencies(), 3, 2);
    const [first, second] = await Promise.all([
      (worker as any).claimNextPendingTask(),
      (worker as any).claimNextPendingTask(),
    ]);

    const claimed = [first, second].filter((task) => task != null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("running");

    const rows = await db.all<{ id: number; status: string; workerOwner: string | null; leaseExpiresAt: number | null }>(
      "select id, status, workerOwner, leaseExpiresAt from tasks order by id asc"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.workerOwner).toBeTypeOf("string");
    expect(rows[0]?.leaseExpiresAt).toBeTypeOf("number");
  }, 15_000);

  it("recovers only stale interrupted tasks", async () => {
    databaseFile = `worker-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
    const { db, TaskWorker } = await loadWorkerTestModules(`file:${databaseFile}`);

    await db.run(`
      insert into chats (id, type, createdAt, updatedAt)
      values ('chat-1', 'private', 1, 1)
    `);
    await db.run(`
      insert into tasks (
        type, status, conversationId, chatId, retryCount,
        workerOwner, leaseExpiresAt, cancelRequestedAt, startedAt, createdAt, updatedAt
      )
      values
        ('chat', 'running', 'conv-1', 'chat-1', 0, 'worker-a', 500, null, 1, 1, 1),
        ('chat', 'cancelling', 'conv-2', 'chat-1', 0, 'worker-a', 500, 2, null, 2, 2),
        ('chat', 'running', 'conv-3', 'chat-1', 0, 'worker-b', 5000, null, 950, 950, 950),
        ('chat', 'cancelling', 'conv-4', 'chat-1', 0, 'worker-b', 5000, 960, null, 960, 960),
        ('chat', 'pending', 'conv-5', 'chat-1', 0, null, null, null, null, 3, 3)
    `);

    const worker = new TaskWorker(createTestDependencies(), 3, 2);
    await (worker as any).recoverStaleInterruptedTasks(1_500);

    const rows = await db.all<{
      conversationId: string;
      status: string;
      finishedAt: number | null;
      workerOwner: string | null;
      leaseExpiresAt: number | null;
    }>(`
      select conversationId, status, finishedAt, workerOwner, leaseExpiresAt
      from tasks
      order by createdAt asc
    `);

    const byConversationId = new Map(
      rows.map((row) => [row.conversationId, row] as const)
    );

    expect(byConversationId.get("conv-1")?.status).toBe("pending");
    expect(byConversationId.get("conv-1")?.workerOwner).toBeNull();
    expect(byConversationId.get("conv-1")?.leaseExpiresAt).toBeNull();
    expect(byConversationId.get("conv-2")?.status).toBe("cancelled");
    expect(byConversationId.get("conv-2")?.finishedAt).not.toBeNull();
    expect(byConversationId.get("conv-2")?.workerOwner).toBeNull();
    expect(byConversationId.get("conv-2")?.leaseExpiresAt).toBeNull();
    expect(byConversationId.get("conv-3")?.status).toBe("running");
    expect(byConversationId.get("conv-3")?.workerOwner).toBe("worker-b");
    expect(byConversationId.get("conv-4")?.status).toBe("cancelling");
    expect(byConversationId.get("conv-4")?.workerOwner).toBe("worker-b");
    expect(byConversationId.get("conv-5")?.status).toBe("pending");
  }, 15_000);
});
