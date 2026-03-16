import { resolveBranchReferenceTelegramMessageId } from "../bot/conversation-store.js";
import {
  ChatResponseDelivery,
} from "./chat-delivery.js";
import { resolveEffectiveConversationId } from "./chat-decision.js";
import type { TelegramActionPlan, TelegramContextPacket } from "../infra/ai/telegram-action-schema.js";
import type { TaskDependencies, TaskRecord } from "./types.js";

function getMessageTelegramId(packet: TelegramContextPacket, refId: string | null) {
  if (refId == null) {
    return null;
  }

  const ref = packet.refs[refId];
  if (ref?.kind !== "message") {
    return null;
  }

  return ref.telegramMessageId;
}

function getStickerFileId(packet: TelegramContextPacket, refId: string) {
  const ref = packet.refs[refId];
  if (ref?.kind !== "sticker") {
    return null;
  }

  return ref.telegramFileId;
}

function buildReplyParametersFromPlan(
  packet: TelegramContextPacket,
  operation: Extract<TelegramActionPlan["operations"][number], { type: "send_message" }>
) {
  const replyToMessageId = getMessageTelegramId(packet, operation.replyToRef);
  if (replyToMessageId == null) {
    return null;
  }

  const quoteRef = operation.quoteRef == null ? null : packet.refs[operation.quoteRef];
  if (quoteRef?.kind === "message" && quoteRef.quote != null) {
    return {
      message_id: replyToMessageId,
      quote: quoteRef.quote.text,
      ...(quoteRef.quote.offset == null
        ? {}
        : { quote_position: quoteRef.quote.offset }),
    };
  }

  return {
    message_id: replyToMessageId,
  };
}

async function resolveReferenceTelegramMessageId(options: {
  packet: TelegramContextPacket;
  record: Pick<TaskRecord, "chatId" | "triggerTelegramMessageId">;
  replyToRef: string | null;
  threadId?: number;
}) {
  const replyToMessageId = getMessageTelegramId(options.packet, options.replyToRef);
  if (replyToMessageId == null) {
    return options.record.triggerTelegramMessageId ?? null;
  }

  return resolveBranchReferenceTelegramMessageId({
    chatId: options.record.chatId,
    telegramMessageId: replyToMessageId,
    ...(options.threadId == null ? {} : { threadId: options.threadId }),
  }).catch(() => replyToMessageId);
}

export async function executeTelegramActionPlan(options: {
  plan: TelegramActionPlan;
  packet: TelegramContextPacket;
  effectiveConversationId: string;
  threadId?: number;
  dependencies: Pick<TaskDependencies, "api" | "taskRuntime">;
  record: Pick<
    TaskRecord,
    "id" | "chatId" | "userId" | "triggerTelegramMessageId"
  >;
  getFailureState?: () => Promise<{
    cancellationRequested: boolean;
    timedOut: boolean;
  }>;
}) {
  const {
    plan,
    packet,
    effectiveConversationId,
    threadId,
    dependencies,
    record,
  } = options;
  const operationResults: Array<Record<string, unknown>> = [];
  let responseMessageId: number | null = null;
  let responseText: string | null = null;
  let lastOutputMessageId: number | null = null;

  for (const operation of plan.operations) {
    switch (operation.type) {
      case "cancel_task": {
        const scope =
          operation.scope === "latest_in_chat"
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

        const outcome = await dependencies.taskRuntime.requestCancelLatest(scope);
        operationResults.push({
          opId: operation.opId,
          type: operation.type,
          result: outcome.result,
          taskId: outcome.task?.id ?? null,
        });
        break;
      }
      case "enqueue_task": {
        const conversationId = resolveEffectiveConversationId({
          currentConversationId: effectiveConversationId,
          requestedConversation: {
            mode: operation.conversation.mode,
            anchorMessageId: getMessageTelegramId(
              packet,
              operation.conversation.anchorRef
            ),
          },
          fallbackAnchorMessageId: record.triggerTelegramMessageId ?? null,
          fallbackBranchRootMessageId:
            getMessageTelegramId(packet, operation.conversation.branchRootRef) ??
            record.triggerTelegramMessageId ??
            null,
        });
        const queuedTask = await dependencies.taskRuntime.enqueueChatTask({
          conversationId,
          chatId: record.chatId,
          ...(record.userId ? { userId: record.userId } : {}),
          ...(record.triggerTelegramMessageId != null
            ? { triggerTelegramMessageId: record.triggerTelegramMessageId }
            : {}),
          payload: {
            text: operation.input,
            userInput: operation.input,
            ...(threadId == null ? {} : { threadId }),
            allowTaskActions: false,
            originTaskId: record.id,
          },
        });
        operationResults.push({
          opId: operation.opId,
          type: operation.type,
          conversationId,
          queuedTask,
        });
        break;
      }
      case "send_message": {
        const replyToMessageId = getMessageTelegramId(packet, operation.replyToRef);
        const referenceTelegramMessageId = await resolveReferenceTelegramMessageId({
          packet,
          record,
          replyToRef: operation.replyToRef,
          ...(threadId == null ? {} : { threadId }),
        });
        const delivery = new ChatResponseDelivery(
          { api: dependencies.api } as Pick<TaskDependencies, "api">,
          record as TaskRecord,
          {
            ...(threadId == null ? {} : { threadId }),
            ...(buildReplyParametersFromPlan(packet, operation) == null
              ? {}
              : { replyParameters: buildReplyParametersFromPlan(packet, operation) }),
            contextParentTelegramMessageId: replyToMessageId,
            contextReferenceTelegramMessageId: referenceTelegramMessageId,
          }
        );

        let deliveryResult;
        try {
          await delivery.start(effectiveConversationId);
          deliveryResult = await delivery.deliverText({
            conversationId: effectiveConversationId,
            text: operation.text,
          });
        } catch (error) {
          if (options.getFailureState) {
            const failureState = await options.getFailureState();
            await delivery.fail({
              conversationId: effectiveConversationId,
              cancellationRequested: failureState.cancellationRequested,
              timedOut: failureState.timedOut,
            });
          }

          throw error;
        }
        responseMessageId ??= deliveryResult.primaryMessageId;
        responseText ??= operation.text;
        lastOutputMessageId = deliveryResult.primaryMessageId ?? lastOutputMessageId;
        operationResults.push({
          opId: operation.opId,
          type: operation.type,
          primaryMessageId: deliveryResult.primaryMessageId,
          messageIds: deliveryResult.messageIds,
        });
        break;
      }
      case "send_sticker": {
        const fileId = getStickerFileId(packet, operation.stickerRef);
        if (fileId == null) {
          throw new Error(`Sticker ref ${operation.stickerRef} has no file id`);
        }

        const replyToMessageId = getMessageTelegramId(packet, operation.replyToRef);
        const referenceTelegramMessageId = await resolveReferenceTelegramMessageId({
          packet,
          record,
          replyToRef: operation.replyToRef,
          ...(threadId == null ? {} : { threadId }),
        });
        const delivery = new ChatResponseDelivery(
          { api: dependencies.api } as Pick<TaskDependencies, "api">,
          record as TaskRecord,
          {
            ...(threadId == null ? {} : { threadId }),
            ...(replyToMessageId == null
              ? {}
              : { replyParameters: { message_id: replyToMessageId } }),
            contextParentTelegramMessageId:
              lastOutputMessageId ?? replyToMessageId,
            contextReferenceTelegramMessageId: referenceTelegramMessageId,
          }
        );

        let message;
        if (lastOutputMessageId == null) {
          message = await delivery.deliverStickerOnly({
            conversationId: effectiveConversationId,
            fileId,
          });
        } else {
          message = await delivery.sendSticker({
            conversationId: effectiveConversationId,
            fileId,
            parentTelegramMessageId: lastOutputMessageId,
          });
        }

        responseMessageId ??= message.message_id;
        lastOutputMessageId = message.message_id;
        operationResults.push({
          opId: operation.opId,
          type: operation.type,
          messageId: message.message_id,
        });
        break;
      }
    }
  }

  return {
    responseMessageId,
    responseText,
    operationResults,
  };
}
