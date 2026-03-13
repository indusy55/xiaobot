import { and, asc, desc, eq, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { tasksTable } from "../db/schema.js";
import { logError } from "../infra/error/index.js";
import { createTask } from "./factory.js";
import type {
  CancelTaskResult,
  CancelTaskScope,
  RetryTaskResult,
  TaskDependencies,
  TaskRecord,
} from "./types.js";

export class TaskWorker {
  private isPolling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dependencies: TaskDependencies,
    private readonly maxAttempts = 3
  ) {}

  async runNext() {
    const task = await this.claimNextPendingTask();
    if (!task) {
      return null;
    }

    try {
      await createTask(task, this.dependencies).run();
    } catch (error) {
      logError("TASK_WORKER", error, {
        taskId: task.id,
        taskType: task.type,
      });

      if (task.retryCount + 1 < this.maxAttempts) {
        await db
          .update(tasksTable)
          .set({
            status: "pending",
            retryCount: task.retryCount + 1,
            updatedAt: Date.now(),
          })
          .where(eq(tasksTable.id, task.id));
      }
    }

    return task.id;
  }

  startPolling(idleMs = 1000, busyMs = 100) {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    const tick = async () => {
      if (!this.isPolling) {
        return;
      }

      try {
        const taskId = await this.runNext();
        const nextDelay = taskId == null ? idleMs : busyMs;
        this.pollTimer = setTimeout(() => {
          void tick();
        }, nextDelay);
      } catch (error) {
        logError("TASK_WORKER_POLL", error);
        this.pollTimer = setTimeout(() => {
          void tick();
        }, idleMs);
      }
    };

    void this.recoverInterruptedTasks()
      .catch((error) => {
        logError("TASK_WORKER_RECOVERY", error);
      })
      .finally(() => {
        void tick();
      });
  }

  stopPolling() {
    this.isPolling = false;
    if (this.pollTimer != null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async requestCancel(
    taskId: number,
    scope?: CancelTaskScope
  ): Promise<CancelTaskResult> {
    const task = await this.findTaskById(taskId, scope);
    if (!task) {
      return { result: "not_found", task: null };
    }

    if (["completed", "failed", "cancelled"].includes(task.status)) {
      return { result: "already_finished", task };
    }

    const now = Date.now();

    if (task.status === "pending") {
      await db
        .update(tasksTable)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasksTable.id, taskId),
            eq(tasksTable.status, "pending")
          )
        );

      return {
        result: "cancelled",
        task: await this.findTaskById(taskId, scope),
      };
    }

    await db
      .update(tasksTable)
      .set({
        status: "cancelling",
        cancelRequestedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasksTable.id, taskId),
          or(eq(tasksTable.status, "running"), eq(tasksTable.status, "cancelling"))
        )
      );

    return {
      result: "requested",
      task: await this.findTaskById(taskId, scope),
    };
  }

  async requestCancelLatest(scope: CancelTaskScope): Promise<CancelTaskResult> {
    const task = await this.findLatestCancellableTask(scope);
    if (!task) {
      return { result: "not_found", task: null };
    }

    return this.requestCancel(task.id, scope);
  }

  async retryTask(
    taskId: number,
    scope?: CancelTaskScope
  ): Promise<RetryTaskResult> {
    const sourceTask = await this.findTaskById(taskId, scope);
    if (!sourceTask) {
      return {
        result: "not_found",
        sourceTask: null,
        retriedTask: null,
      };
    }

    if (["pending", "running", "cancelling"].includes(sourceTask.status)) {
      return {
        result: "not_finished",
        sourceTask,
        retriedTask: null,
      };
    }

    const now = Date.now();
    const [retriedTask] = await db
      .insert(tasksTable)
      .values({
        type: sourceTask.type,
        status: "pending",
        conversationId: sourceTask.conversationId,
        chatId: sourceTask.chatId,
        userId: sourceTask.userId,
        triggerTelegramMessageId: sourceTask.triggerTelegramMessageId,
        payload: sourceTask.payload,
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return {
      result: "queued",
      sourceTask,
      retriedTask: retriedTask as TaskRecord,
    };
  }

  private async recoverInterruptedTasks() {
    const now = Date.now();

    await db
      .update(tasksTable)
      .set({
        status: "pending",
        updatedAt: now,
      })
      .where(eq(tasksTable.status, "running"));

    await db
      .update(tasksTable)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(tasksTable.status, "cancelling"));
  }

  private async claimNextPendingTask() {
    const [nextTask] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.status, "pending"))
      .orderBy(asc(tasksTable.createdAt))
      .limit(1);

    if (!nextTask) {
      return null;
    }

    const now = Date.now();

    await db
      .update(tasksTable)
      .set({
        status: "running",
        startedAt: nextTask.startedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasksTable.id, nextTask.id),
          eq(tasksTable.status, "pending")
        )
      );

    const [claimedTask] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, nextTask.id))
      .limit(1);

    if (!claimedTask || claimedTask.status !== "running") {
      return null;
    }

    return claimedTask as TaskRecord;
  }

  private async findTaskById(taskId: number, scope?: CancelTaskScope) {
    if (scope?.excludeTaskId && taskId === scope.excludeTaskId) {
      return null;
    }

    const [task] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);

    if (!task) {
      return null;
    }

    if (scope?.conversationId && task.conversationId !== scope.conversationId) {
      return null;
    }

    if (scope?.chatId && task.chatId !== scope.chatId) {
      return null;
    }

    if (scope?.userId && task.userId !== scope.userId) {
      return null;
    }

    return task as TaskRecord;
  }

  private async findLatestCancellableTask(scope: CancelTaskScope) {
    const conditions = [
      or(
        eq(tasksTable.status, "pending"),
        eq(tasksTable.status, "running"),
        eq(tasksTable.status, "cancelling")
      ),
    ];

    if (scope.conversationId) {
      conditions.push(eq(tasksTable.conversationId, scope.conversationId));
    }

    if (scope.chatId) {
      conditions.push(eq(tasksTable.chatId, scope.chatId));
    }

    if (scope.userId) {
      conditions.push(eq(tasksTable.userId, scope.userId));
    }

    if (scope.excludeTaskId) {
      conditions.push(ne(tasksTable.id, scope.excludeTaskId));
    }

    const [task] = await db
      .select()
      .from(tasksTable)
      .where(and(...conditions))
      .orderBy(desc(tasksTable.createdAt))
      .limit(1);

    return task ? (task as TaskRecord) : null;
  }
}
