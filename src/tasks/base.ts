import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { messagesTable, tasksTable } from "../db/schema.js";
import type {
  TaskContextMessage,
  TaskDependencies,
  TaskRecord,
  TaskStatus,
} from "./types.js";

const taskContextMessageSelection = {
  id: messagesTable.id,
  role: messagesTable.role,
  chatType: messagesTable.chatType,
  chatTitle: messagesTable.chatTitle,
  contentType: messagesTable.contentType,
  textContent: messagesTable.textContent,
  replyToTelegramMessageId: messagesTable.replyToTelegramMessageId,
  fromId: messagesTable.fromId,
  fromUsername: messagesTable.fromUsername,
  fromFirstName: messagesTable.fromFirstName,
  fromLastName: messagesTable.fromLastName,
  fromLanguageCode: messagesTable.fromLanguageCode,
  telegramMessageId: messagesTable.telegramMessageId,
  createdAt: messagesTable.createdAt,
} as const;

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["running", "cancelling", "failed"],
  running: ["cancelling", "completed", "failed"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  completed: [],
  failed: ["pending"],
};

function buildThreadScopeCondition(threadId?: number) {
  return threadId == null
    ? isNull(messagesTable.threadId)
    : eq(messagesTable.threadId, threadId);
}

export abstract class BaseTask {
  constructor(
    protected task: TaskRecord,
    protected readonly dependencies: TaskDependencies
  ) {}

  get record() {
    return this.task;
  }

  async run() {
    const current = await this.reload();
    if (current.status === "pending") {
      await this.transitionTo("running");
    } else if (current.status !== "running") {
      throw new Error(
        `Task ${current.id} cannot run from status ${current.status}`
      );
    }

    const controller = new AbortController();

    try {
      await this.throwIfCancellationRequested();
      const result = await this.execute(controller.signal);
      await this.throwIfCancellationRequested();
      await this.transitionTo("completed", {
        result: result === undefined ? null : JSON.stringify(result),
        errorMessage: null,
      });
    } catch (error) {
      if (await this.isCancellationRequested()) {
        await this.transitionTo("cancelled");
        return;
      }

      await this.transitionTo("failed", {
        errorMessage:
          error instanceof Error ? error.message : "Unknown task error",
      });
      throw error;
    }
  }

  async requestCancel() {
    const current = await this.reload();
    if (!["pending", "running", "cancelling"].includes(current.status)) {
      return current;
    }

    return this.transitionTo("cancelling", {
      cancelRequestedAt: Date.now(),
    });
  }

  protected abstract execute(signal: AbortSignal): Promise<unknown>;

  protected async loadContext(limit = 20): Promise<TaskContextMessage[]> {
    const rows = await db
      .select(taskContextMessageSelection)
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.conversationId, this.task.conversationId),
          eq(messagesTable.chatId, this.task.chatId)
        )
      )
      .orderBy(asc(messagesTable.createdAt))
      .limit(limit);

    return rows;
  }

  protected async loadRecentChatMessages(
    limit = 50,
    threadId?: number
  ): Promise<TaskContextMessage[]> {
    const rows = await db
      .select(taskContextMessageSelection)
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.chatId, this.task.chatId),
          buildThreadScopeCondition(threadId)
        )
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit);

    return rows.reverse();
  }

  protected async loadMessageByTelegramMessageId(
    telegramMessageId: number,
    threadId?: number
  ) {
    const [message] = await db
      .select(taskContextMessageSelection)
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.chatId, this.task.chatId),
          eq(messagesTable.telegramMessageId, telegramMessageId),
          buildThreadScopeCondition(threadId)
        )
      )
      .limit(1);

    return (message as TaskContextMessage | undefined) ?? null;
  }

  protected async saveContextSnapshot(snapshot: unknown) {
    return this.updateTask({
      contextSnapshot: JSON.stringify(snapshot),
    });
  }

  protected async throwIfCancellationRequested() {
    if (await this.isCancellationRequested()) {
      throw new Error(`Task ${this.task.id} was cancelled`);
    }
  }

  protected async cancellationRequested() {
    return this.isCancellationRequested();
  }

  protected async reload() {
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, this.task.id))
      .limit(1);

    if (!task) {
      throw new Error(`Task ${this.task.id} not found`);
    }

    this.task = task as TaskRecord;
    return this.task;
  }

  protected async transitionTo(
    nextStatus: TaskStatus,
    extra: Partial<Pick<TaskRecord, "contextSnapshot" | "result" | "errorMessage" | "cancelRequestedAt">> = {}
  ) {
    const current = await this.reload();
    if (current.status !== nextStatus) {
      const allowed = ALLOWED_TRANSITIONS[current.status];
      if (!allowed.includes(nextStatus)) {
        throw new Error(
          `Invalid task status transition: ${current.status} -> ${nextStatus}`
        );
      }
    }

    const now = Date.now();
    const updates: Record<string, unknown> = {
      status: nextStatus,
      updatedAt: now,
      ...extra,
    };

    if (nextStatus === "running" && current.startedAt == null) {
      updates.startedAt = now;
    }

    if (["completed", "cancelled", "failed"].includes(nextStatus)) {
      updates.finishedAt = now;
    }

    await db
      .update(tasksTable)
      .set(updates)
      .where(and(eq(tasksTable.id, current.id), eq(tasksTable.status, current.status)));

    return this.reload();
  }

  private async updateTask(
    extra: Partial<Pick<TaskRecord, "contextSnapshot" | "result" | "errorMessage" | "cancelRequestedAt">>
  ) {
    await db
      .update(tasksTable)
      .set({
        ...extra,
        updatedAt: Date.now(),
      })
      .where(eq(tasksTable.id, this.task.id));

    return this.reload();
  }

  private async isCancellationRequested() {
    const current = await this.reload();
    return current.status === "cancelling" || current.cancelRequestedAt != null;
  }
}
