import { buildConversationBacklogSummary } from "../infra/ai/conversation-summary.js";
import { buildRuntimeContextPrompt } from "../infra/ai/runtime-context.js";
import {
  applyChatUserInputOverride,
  buildLatestUserInputContext,
  collectReusableToolObservations,
  findChatTriggerMessage,
  type ChatLatestUserInputContext,
  type ChatTaskSnapshotRecord,
  type ChatToolObservationRecord,
} from "./chat-context.js";
import type { ChatTaskPayload, TaskContextMessage } from "./types.js";

export interface PreparedChatTurn {
  payload: ChatTaskPayload;
  threadId: number | undefined;
  contextMessages: TaskContextMessage[];
  recentChatMessages: TaskContextMessage[];
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
  runtimeContextPrompt: string;
  latestUserInputContext: ChatLatestUserInputContext;
  backlogSummary: string | null;
  priorToolObservations: ChatToolObservationRecord[];
}

export async function prepareChatTurn(options: {
  payload: ChatTaskPayload;
  triggerTelegramMessageId: number | null;
  chatContextLimit: number;
  chatContextSummaryLimit: number;
  loadContext: (limit: number) => Promise<TaskContextMessage[]>;
  loadOlderConversationMessages: (
    beforeCreatedAt: number,
    limit: number
  ) => Promise<TaskContextMessage[]>;
  loadRecentChatMessages: (
    limit: number,
    threadId?: number
  ) => Promise<TaskContextMessage[]>;
  loadMessageByTelegramMessageId: (
    telegramMessageId: number,
    threadId?: number
  ) => Promise<TaskContextMessage | null>;
  loadRecentConversationTaskSnapshots: (
    limit: number
  ) => Promise<ChatTaskSnapshotRecord[]>;
}) {
  const {
    payload,
    triggerTelegramMessageId,
    chatContextLimit,
    chatContextSummaryLimit,
    loadContext,
    loadOlderConversationMessages,
    loadRecentChatMessages,
    loadMessageByTelegramMessageId,
    loadRecentConversationTaskSnapshots,
  } = options;
  const threadId = payload.threadId;
  const rawContextMessages = await loadContext(chatContextLimit);
  const contextMessages = applyChatUserInputOverride(
    rawContextMessages,
    triggerTelegramMessageId,
    payload.userInput
  );
  const oldestContextMessage = contextMessages[0] ?? null;
  const olderConversationMessages =
    oldestContextMessage != null && contextMessages.length >= chatContextLimit
      ? await loadOlderConversationMessages(
          oldestContextMessage.createdAt,
          chatContextSummaryLimit
        )
      : [];
  const recentChatMessages = await loadRecentChatMessages(24, threadId);
  const triggerMessage = findChatTriggerMessage(
    contextMessages,
    triggerTelegramMessageId
  );
  const repliedMessage =
    triggerMessage?.replyToTelegramMessageId != null
      ? await loadMessageByTelegramMessageId(
          triggerMessage.replyToTelegramMessageId,
          threadId
        )
      : null;
  const runtimeContextPrompt = buildRuntimeContextPrompt({
    conversationMessages: contextMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
  });
  const latestUserInputContext = buildLatestUserInputContext({
    payload,
    triggerMessage,
  });
  const backlogSummary = buildConversationBacklogSummary(
    olderConversationMessages
  );
  const recentTaskSnapshots = await loadRecentConversationTaskSnapshots(4);
  const priorToolObservations = collectReusableToolObservations(
    recentTaskSnapshots
  );

  return {
    payload,
    threadId,
    contextMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
    runtimeContextPrompt,
    latestUserInputContext,
    backlogSummary,
    priorToolObservations,
  } satisfies PreparedChatTurn;
}
