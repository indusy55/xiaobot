import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
  private readonly workerOwner = randomUUID();
  private isPolling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRuns = 0;

  constructor(
    private readonly dependencies: TaskDependencies,
    private readonly maxAttempts = 3,
    private readonly maxConcurrentRuns = 2
  ) {}

  private get leaseDurationMs() {
    return this.dependencies.taskTimeoutMs + 5_000;
  }

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

      await this.retryFailedTask(task);
    }

    return task.id;
  }

  startPolling(idleMs = 1000, busyMs = 100) {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    void this.recoverStaleInterruptedTasks()
      .catch((error) => {
        logError("TASK_WORKER_RECOVERY", error);
      })
      .finally(() => {
        this.schedulePoll(0, idleMs, busyMs);
      });
  }

  stopPolling() {
    this.isPolling = false;
    if (this.pollTimer != null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(delayMs: number, idleMs: number, busyMs: number) {
    if (!this.isPolling || this.pollTimer != null) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll(idleMs, busyMs);
    }, delayMs);
  }

  private async poll(idleMs: number, busyMs: number) {
    if (!this.isPolling) {
      return;
    }

    try {
      await this.recoverStaleInterruptedTasks();
      let launched = 0;

      while (this.isPolling && this.activeRuns < this.maxConcurrentRuns) {
        const task = await this.claimNextPendingTask();
        if (!task) {
          break;
        }

        launched += 1;
        this.activeRuns += 1;
        void this.runClaimedTask(task, idleMs, busyMs);
      }

      const nextDelay =
        launched > 0 || this.activeRuns > 0 ? busyMs : idleMs;
      this.schedulePoll(nextDelay, idleMs, busyMs);
    } catch (error) {
      logError("TASK_WORKER_POLL", error);
      this.schedulePoll(idleMs, idleMs, busyMs);
    }
  }

  private async runClaimedTask(
    task: TaskRecord,
    idleMs: number,
    busyMs: number
  ) {
    try {
      await createTask(task, this.dependencies).run();
    } catch (error) {
      logError("TASK_WORKER", error, {
        taskId: task.id,
        taskType: task.type,
      });

      await this.retryFailedTask(task);
    } finally {
      this.activeRuns = Math.max(this.activeRuns - 1, 0);
      this.schedulePoll(0, idleMs, busyMs);
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
          workerOwner: null,
          leaseExpiresAt: null,
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

  private async recoverStaleInterruptedTasks(now = Date.now()) {
    const staleBefore = now - this.dependencies.taskTimeoutMs;

    await db
      .update(tasksTable)
      .set({
        status: "pending",
        workerOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasksTable.status, "running"),
          or(
            sql`${tasksTable.leaseExpiresAt} <= ${now}`,
            sql`${tasksTable.leaseExpiresAt} is null and ${tasksTable.startedAt} <= ${staleBefore}`,
            sql`${tasksTable.startedAt} <= ${staleBefore}`,
            sql`${tasksTable.updatedAt} <= ${staleBefore}`
          )
        )
      );

    await db
      .update(tasksTable)
      .set({
        status: "cancelled",
        workerOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasksTable.status, "cancelling"),
          or(
            sql`${tasksTable.leaseExpiresAt} <= ${now}`,
            sql`${tasksTable.leaseExpiresAt} is null and ${tasksTable.cancelRequestedAt} <= ${staleBefore}`,
            sql`${tasksTable.cancelRequestedAt} <= ${staleBefore}`,
            sql`${tasksTable.updatedAt} <= ${staleBefore}`
          )
        )
      );
  }

  private async claimNextPendingTask() {
    const now = Date.now();
    const leaseExpiresAt = now + this.leaseDurationMs;
    const [claimedTask] = await db.all<TaskRecord>(sql`
      with next_task as (
        select id
        from tasks
        where status = 'pending'
        order by createdAt asc
        limit 1
      )
      update tasks
      set
        status = 'running',
        workerOwner = ${this.workerOwner},
        leaseExpiresAt = ${leaseExpiresAt},
        startedAt = coalesce(startedAt, ${now}),
        updatedAt = ${now}
      where id = (select id from next_task)
        and status = 'pending'
      returning *
    `);

    return claimedTask ?? null;
  }

  private async retryFailedTask(task: TaskRecord) {
    const currentTask = await this.findTaskById(task.id);
    if (!currentTask || currentTask.status !== "failed") {
      return;
    }

    if (currentTask.retryCount + 1 >= this.maxAttempts) {
      return;
    }

    await db
      .update(tasksTable)
      .set({
        status: "pending",
        retryCount: currentTask.retryCount + 1,
        workerOwner: null,
        leaseExpiresAt: null,
        updatedAt: Date.now(),
      })
      .where(and(eq(tasksTable.id, currentTask.id), eq(tasksTable.status, "failed")));
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
