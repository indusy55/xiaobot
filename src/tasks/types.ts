import type { ChatOpenAI } from "@langchain/openai";
import type { AppApi } from "../bot/types.js";

export const TASK_TYPES = ["chat"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = [
  "pending",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  id: number;
  type: TaskType;
  status: TaskStatus;
  conversationId: string;
  chatId: string;
  userId: string | null;
  triggerTelegramMessageId: number | null;
  payload: string | null;
  contextSnapshot: string | null;
  result: string | null;
  errorMessage: string | null;
  retryCount: number;
  cancelRequestedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskContextMessage {
  id: number;
  role: "user" | "assistant" | "system" | "tool";
  chatType: string;
  chatTitle: string | null;
  contentType: string;
  textContent: string | null;
  rawMessage: string | null;
  replyToTelegramMessageId: number | null;
  fromId: string | null;
  fromUsername: string | null;
  fromFirstName: string | null;
  fromLastName: string | null;
  fromLanguageCode: string | null;
  telegramMessageId: number | null;
  createdAt: number;
}

export interface CreateChatTaskInput {
  conversationId: string;
  chatId: string;
  userId?: string;
  triggerTelegramMessageId?: number;
  payload?: Record<string, unknown>;
}

export interface ChatTaskPayload {
  text?: string;
  userInput?: string;
  updateId?: number;
  threadId?: number;
  allowTaskActions?: boolean;
  originTaskId?: number;
}

export interface TaskRuntime {
  enqueueChatTask(input: CreateChatTaskInput): Promise<unknown>;
  requestCancelLatest(scope: CancelTaskScope): Promise<CancelTaskResult>;
}

export interface TaskDependencies {
  api: AppApi;
  chatModel: ChatOpenAI;
  decisionModel: ChatOpenAI;
  taskRuntime: TaskRuntime;
  taskTimeoutMs: number;
  chatContextLimit: number;
  chatContextSummaryLimit: number;
  telegramMediaCacheDir: string;
}

export interface CancelTaskScope {
  chatId?: string;
  conversationId?: string;
  excludeTaskId?: number;
  userId?: string;
}

export interface CancelTaskResult {
  result:
    | "requested"
    | "cancelled"
    | "already_finished"
    | "not_found";
  task: TaskRecord | null;
}

export interface RetryTaskResult {
  result: "queued" | "not_found" | "not_finished";
  sourceTask: TaskRecord | null;
  retriedTask: TaskRecord | null;
}
