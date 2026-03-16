import {
  buildAnchoredConversationId,
  getBaseConversationId,
} from "../bot/conversation.js";
import { buildReplyQuoteParameters } from "../bot/message-quote.js";
import {
  buildChatDecisionMessages,
  buildFallbackChatDecision,
  sanitizeChatDecision,
  parseChatDecisionResponse,
  type ChatDecisionStickerCandidate,
} from "../infra/ai/decision.js";
import { logError } from "../infra/error/index.js";
import type { TaskContextMessage, TaskRecord, TaskDependencies } from "./types.js";

export async function decideChatNextStep(options: {
  record: Pick<TaskRecord, "id" | "chatId" | "conversationId" | "triggerTelegramMessageId">;
  decisionModel: TaskDependencies["decisionModel"];
  allowTaskActions: boolean;
  decisionTimeoutMs: number;
  signal: AbortSignal;
  runtimeContextPrompt: string;
  contextMessages: TaskContextMessage[];
  recentChatMessages: TaskContextMessage[];
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
  availableStickers?: ChatDecisionStickerCandidate[];
}) {
  const {
    record,
    decisionModel,
    allowTaskActions,
    decisionTimeoutMs,
    signal,
    runtimeContextPrompt,
    contextMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
    availableStickers,
  } = options;

  try {
    const decisionMessages = buildChatDecisionMessages({
      runtimeContextPrompt,
      conversationId: record.conversationId,
      conversationMessages: contextMessages,
      recentChatMessages,
      triggerMessage,
      repliedMessage,
      ...(availableStickers == null ? {} : { availableStickers }),
    });
    const decisionSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(decisionTimeoutMs),
    ]);
    const decisionMessage = await decisionModel.invoke(decisionMessages, {
      signal: decisionSignal,
    });
    const rawDecision = parseChatDecisionResponse(decisionMessage);

    return sanitizeChatDecision(rawDecision, {
      allowTaskActions,
      triggerTelegramMessageId: record.triggerTelegramMessageId,
      triggerUserId: triggerMessage?.fromId ?? null,
      repliedTelegramMessageId: repliedMessage?.telegramMessageId ?? null,
      conversationMessages: contextMessages,
      recentChatMessages,
      availableStickerIds: new Set(
        (availableStickers ?? []).map((sticker) => sticker.id)
      ),
    });
  } catch (error) {
    logError("CHAT_DECISION", error, {
      taskId: record.id,
      conversationId: record.conversationId,
      chatId: record.chatId,
    });

    return buildFallbackChatDecision(record.triggerTelegramMessageId);
  }
}

export function resolveEffectiveConversationId(options: {
  currentConversationId: string;
  requestedConversation: {
    mode: "continue" | "new" | "fork_from_message";
    anchorMessageId: number | null;
  };
  fallbackAnchorMessageId: number | null;
}) {
  const { currentConversationId, requestedConversation, fallbackAnchorMessageId } =
    options;
  const baseConversationId = getBaseConversationId(currentConversationId);

  switch (requestedConversation.mode) {
    case "continue":
      return currentConversationId;
    case "new":
    case "fork_from_message": {
      const anchorMessageId =
        requestedConversation.anchorMessageId ?? fallbackAnchorMessageId;

      if (anchorMessageId == null) {
        return currentConversationId;
      }

      return buildAnchoredConversationId(baseConversationId, anchorMessageId);
    }
  }
}

export function buildDecisionReplyParameters(
  triggerMessage: TaskContextMessage | null,
  repliedMessage: TaskContextMessage | null,
  replyToMessageId: number | null
) {
  if (replyToMessageId == null) {
    return null;
  }

  if (
    triggerMessage?.replyToTelegramMessageId === replyToMessageId &&
    repliedMessage?.telegramMessageId === replyToMessageId
  ) {
    return buildReplyQuoteParameters({
      rawMessage: triggerMessage.rawMessage,
      replyToMessageId,
    });
  }

  return {
    message_id: replyToMessageId,
  };
}
