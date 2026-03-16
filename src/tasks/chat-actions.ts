import { type ChatTaskAction } from "../infra/ai/decision.js";
import { resolveEffectiveConversationId } from "./chat-decision.js";
import type { TaskRecord, TaskRuntime } from "./types.js";

export async function executeChatTaskActions(options: {
  taskActions: ChatTaskAction[];
  effectiveConversationId: string;
  threadId?: number;
  record: Pick<
    TaskRecord,
    "id" | "chatId" | "userId" | "triggerTelegramMessageId"
  >;
  taskRuntime: TaskRuntime;
}) {
  const { taskActions, effectiveConversationId, threadId, record, taskRuntime } =
    options;
  const results: Record<string, unknown>[] = [];

  for (const taskAction of taskActions) {
    if (taskAction.type === "cancel_task") {
      const scope =
        taskAction.scope === "latest_in_chat"
          ? {
              chatId: record.chatId,
              excludeTaskId: record.id,
              ...(record.userId ? { userId: record.userId } : {}),
            }
          : {
              chatId: record.chatId,
              conversationId: effectiveConversationId,
              excludeTaskId: record.id,
              ...(record.userId ? { userId: record.userId } : {}),
            };

      const outcome = await taskRuntime.requestCancelLatest(scope);
      results.push({
        type: "cancel_task",
        scope: taskAction.scope,
        result: outcome.result,
        taskId: outcome.task?.id ?? null,
      });
      continue;
    }

    const conversationId = resolveEffectiveConversationId({
      currentConversationId: effectiveConversationId,
      requestedConversation: taskAction.conversationMode,
      fallbackAnchorMessageId: record.triggerTelegramMessageId ?? null,
    });
    const payload: Record<string, unknown> = {
      text: taskAction.userInput,
      userInput: taskAction.userInput,
      ...(threadId == null ? {} : { threadId }),
      allowTaskActions: false,
      originTaskId: record.id,
    };
    const queuedTask = await taskRuntime.enqueueChatTask({
      conversationId,
      chatId: record.chatId,
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.triggerTelegramMessageId != null
        ? { triggerTelegramMessageId: record.triggerTelegramMessageId }
        : {}),
      payload,
    });

    results.push({
      type: "enqueue_task",
      taskKind: taskAction.taskKind,
      conversationId,
      queuedTask,
    });
  }

  return results;
}
