import { and, asc, desc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { messagesTable, tasksTable } from "../db/schema.js";
import {
  getAnchorMessageId,
  listConversationFamilyIds,
} from "../bot/conversation.js";
import { assembleBranchAwareContext } from "./context-window.js";
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
  rawMessage: messagesTable.rawMessage,
  replyToTelegramMessageId: messagesTable.replyToTelegramMessageId,
  fromId: messagesTable.fromId,
  fromUsername: messagesTable.fromUsername,
  fromFirstName: messagesTable.fromFirstName,
  fromLastName: messagesTable.fromLastName,
  fromLanguageCode: messagesTable.fromLanguageCode,
  telegramMessageId: messagesTable.telegramMessageId,
  parentMessageId: messagesTable.parentMessageId,
  referenceMessageId: messagesTable.referenceMessageId,
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

function buildConversationFamilyCondition(conversationId: string) {
  const familyIds = listConversationFamilyIds(conversationId);

  return familyIds.length === 1
    ? eq(messagesTable.conversationId, familyIds[0] as string)
    : inArray(messagesTable.conversationId, familyIds as string[]);
}

function buildTaskConversationFamilyCondition(conversationId: string) {
  const familyIds = listConversationFamilyIds(conversationId);

  return familyIds.length === 1
    ? eq(tasksTable.conversationId, familyIds[0] as string)
    : inArray(tasksTable.conversationId, familyIds as string[]);
}

export abstract class BaseTask {
  private timedOut = false;
  private readonly expectedWorkerOwner: string | null;

  constructor(
    protected task: TaskRecord,
    protected readonly dependencies: TaskDependencies
  ) {
    this.expectedWorkerOwner = task.workerOwner;
  }

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
    const timeoutSignal = AbortSignal.timeout(this.dependencies.taskTimeoutMs);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    this.timedOut = false;
    timeoutSignal.addEventListener(
      "abort",
      () => {
        this.timedOut = true;
      },
      { once: true }
    );

    try {
      await this.throwIfCancellationRequested();
      const result = await this.execute(signal);
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

      const normalizedError = this.timedOut
        ? new Error(`Task timed out after ${this.dependencies.taskTimeoutMs}ms`)
        : error;

      await this.transitionTo("failed", {
        errorMessage:
          normalizedError instanceof Error
            ? normalizedError.message
            : "Unknown task error",
      });
      throw normalizedError;
    } finally {
      controller.abort();
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
    const anchorMessageId = getAnchorMessageId(this.task.conversationId);
    const triggerTelegramMessageId = this.task.triggerTelegramMessageId;
    if (triggerTelegramMessageId != null) {
      const [triggerRow] = await db
        .select(taskContextMessageSelection)
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.chatId, this.task.chatId),
            eq(messagesTable.telegramMessageId, triggerTelegramMessageId)
          )
        )
        .limit(1);

      if (triggerRow) {
        const conversationRows = await db
          .select(taskContextMessageSelection)
          .from(messagesTable)
          .where(
            and(
              buildConversationFamilyCondition(this.task.conversationId),
              eq(messagesTable.chatId, this.task.chatId),
              or(
                lt(messagesTable.createdAt, triggerRow.createdAt),
                and(
                  eq(messagesTable.createdAt, triggerRow.createdAt),
                  lte(messagesTable.id, triggerRow.id)
                )
              )
            )
          )
          .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id));

        return assembleBranchAwareContext({
          conversationMessages: conversationRows as TaskContextMessage[],
          triggerTelegramMessageId,
          limit,
          anchorMessageId,
        });
      }
    }
    const conversationRows = await db
      .select(taskContextMessageSelection)
      .from(messagesTable)
      .where(
        and(
          buildConversationFamilyCondition(this.task.conversationId),
          eq(messagesTable.chatId, this.task.chatId)
        )
      )
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(anchorMessageId == null ? limit : Math.max(limit - 1, 0));

    if (anchorMessageId == null) {
      return conversationRows.reverse() as TaskContextMessage[];
    }

    const [anchorRow] = await db
      .select(taskContextMessageSelection)
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.chatId, this.task.chatId),
          eq(messagesTable.telegramMessageId, anchorMessageId)
        )
      )
      .limit(1);

    const rows = conversationRows.reverse() as TaskContextMessage[];
    if (!anchorRow) {
      return rows;
    }

    const hasAnchorInConversationRows = rows.some(
      (message) => message.telegramMessageId === anchorMessageId
    );

    if (hasAnchorInConversationRows) {
      return rows;
    }

    return [anchorRow as TaskContextMessage, ...rows].slice(0, limit);
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
      .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(limit);

    return rows.reverse();
  }

  protected async loadOlderConversationMessages(
    beforeCreatedAt: number,
    limit = 10
  ): Promise<TaskContextMessage[]> {
    if (limit <= 0) {
      return [];
    }

    const rows = await db
      .select(taskContextMessageSelection)
      .from(messagesTable)
      .where(
        and(
          buildConversationFamilyCondition(this.task.conversationId),
          eq(messagesTable.chatId, this.task.chatId),
          lt(messagesTable.createdAt, beforeCreatedAt)
        )
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit);

    return rows.reverse() as TaskContextMessage[];
  }

  protected async loadRecentConversationTaskSnapshots(limit = 5) {
    if (limit <= 0) {
      return [];
    }

    const rows = await db
      .select({
        id: tasksTable.id,
        status: tasksTable.status,
        contextSnapshot: tasksTable.contextSnapshot,
        createdAt: tasksTable.createdAt,
      })
      .from(tasksTable)
      .where(
        and(
          buildTaskConversationFamilyCondition(this.task.conversationId),
          eq(tasksTable.chatId, this.task.chatId),
          lt(tasksTable.createdAt, this.task.createdAt)
        )
      )
      .orderBy(desc(tasksTable.createdAt))
      .limit(limit);

    return rows;
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

  protected isTimedOut() {
    return this.timedOut;
  }

  protected async reload() {
    const currentTaskId = this.task.id;
    const [task] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, currentTaskId))
      .limit(1);

    if (!task) {
      throw new Error(`Task ${currentTaskId} not found`);
    }

    const nextTask = task as TaskRecord;
    this.assertTaskOwnership(nextTask);
    this.task = nextTask;
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
      updates.workerOwner = null;
      updates.leaseExpiresAt = null;
    }

    await db
      .update(tasksTable)
      .set(updates)
      .where(
        and(
          eq(tasksTable.id, current.id),
          eq(tasksTable.status, current.status),
          current.workerOwner == null
            ? isNull(tasksTable.workerOwner)
            : eq(tasksTable.workerOwner, current.workerOwner)
        )
      );

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
      .where(
        and(
          eq(tasksTable.id, this.task.id),
          this.task.workerOwner == null
            ? isNull(tasksTable.workerOwner)
            : eq(tasksTable.workerOwner, this.task.workerOwner)
        )
      );

    return this.reload();
  }

  private async isCancellationRequested() {
    const current = await this.reload();
    return current.status === "cancelling" || current.cancelRequestedAt != null;
  }

  private assertTaskOwnership(task: TaskRecord) {
    if (this.expectedWorkerOwner == null) {
      return;
    }

    if (
      task.workerOwner == null &&
      ["completed", "cancelled", "failed"].includes(task.status)
    ) {
      return;
    }

    if (task.workerOwner !== this.expectedWorkerOwner) {
      throw new Error(
        `Task ${task.id} lease ownership changed from ${this.expectedWorkerOwner} to ${task.workerOwner}`
      );
    }
  }
}
