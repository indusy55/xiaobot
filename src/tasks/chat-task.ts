import {
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { assignConversationIdToMessage } from "../bot/conversation-store.js";
import { listStickerCatalog } from "../bot/sticker-store.js";
import { buildChatInputEnvelope } from "../infra/ai/input-envelope.js";
import { readChatPrompt } from "../infra/ai/prompt.js";
import { logError } from "../infra/error/index.js";
import { type WebSearchContext } from "../infra/search/searxng.js";
import { BaseTask } from "./base.js";
import {
  buildChatModelMessages,
  buildResponsePlanPrompt,
  buildToolContextPrompt,
  type ChatToolObservationRecord,
} from "./chat-context.js";
import {
  buildDecisionReplyParameters,
  decideChatNextStep,
  resolveEffectiveConversationId,
} from "./chat-decision.js";
import {
  ChatResponseDelivery,
  extractChatResponseText,
} from "./chat-delivery.js";
import { runChatResearchLoop } from "./chat-research.js";
import {
  isDirectStickerRequest,
  pickFallbackStickerForDirectRequest,
} from "./chat-sticker.js";
import { prepareChatTurn } from "./chat-turn.js";
import { executeChatTaskActions } from "./chat-actions.js";
import type { ChatTaskPayload } from "./types.js";

export class ChatTask extends BaseTask {
  protected async execute(signal: AbortSignal) {
    this.ensureSignalIsActive(signal);

    const preparedTurn = await prepareChatTurn({
      payload: this.parsePayload(),
      triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      chatContextLimit: this.dependencies.chatContextLimit,
      chatContextSummaryLimit: this.dependencies.chatContextSummaryLimit,
      loadContext: this.loadContext.bind(this),
      loadOlderConversationMessages: this.loadOlderConversationMessages.bind(this),
      loadRecentChatMessages: this.loadRecentChatMessages.bind(this),
      loadMessageByTelegramMessageId: this.loadMessageByTelegramMessageId.bind(this),
      loadRecentConversationTaskSnapshots:
        this.loadRecentConversationTaskSnapshots.bind(this),
    });
    const {
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
    } = preparedTurn;

    await this.dependencies.api
      .sendChatAction(this.record.chatId, "typing")
      .catch(() => undefined);

    const stickerCatalog = await listStickerCatalog();
    const decision = await decideChatNextStep({
      record: this.record,
      decisionModel: this.dependencies.decisionModel,
      allowTaskActions: payload.allowTaskActions !== false,
      decisionTimeoutMs: this.dependencies.chatDecisionTimeoutMs,
      signal,
      runtimeContextPrompt,
      contextMessages,
      recentChatMessages,
      triggerMessage,
      repliedMessage,
      availableStickers: stickerCatalog.map((sticker) => ({
        id: sticker.id,
        emoji: sticker.emoji,
        setName: sticker.setName,
        setTitle: sticker.setTitle,
        isAnimated: sticker.isAnimated,
        isVideo: sticker.isVideo,
      })),
    });
    const effectiveConversationId = resolveEffectiveConversationId({
      currentConversationId: this.record.conversationId,
      requestedConversation: decision.conversation,
      fallbackAnchorMessageId:
        repliedMessage?.telegramMessageId ??
        this.record.triggerTelegramMessageId ??
        null,
    });
    const triggerTelegramMessageId = this.record.triggerTelegramMessageId;

    if (
      triggerTelegramMessageId != null &&
      effectiveConversationId !== this.record.conversationId
    ) {
      await assignConversationIdToMessage(
        this.record.chatId,
        triggerTelegramMessageId,
        effectiveConversationId,
        threadId
      );
    }

    const taskActionResults = await executeChatTaskActions({
      taskActions: decision.taskActions,
      effectiveConversationId,
      ...(threadId == null ? {} : { threadId }),
      record: this.record,
      taskRuntime: this.dependencies.taskRuntime,
    });

    let webSearchContext: WebSearchContext | null = null;
    let currentToolObservations: ChatToolObservationRecord[] = [];
    if (decision.action === "respond") {
      currentToolObservations = await runChatResearchLoop({
        record: this.record,
        decisionModel: this.dependencies.decisionModel,
        signal,
        runtimeContextPrompt,
        fallbackQuery: (payload.userInput ?? payload.text ?? "").trim(),
        priorToolObservations,
      });
      const latestSearchObservation = [...currentToolObservations]
        .reverse()
        .find((observation) => observation.type === "web_search");

      webSearchContext =
        latestSearchObservation?.type === "web_search"
          ? (latestSearchObservation.context as WebSearchContext | null)
          : null;
    }

    await this.saveContextSnapshot({
      triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      decision,
      effectiveConversationId,
      taskActionResults,
      webSearchContext,
      toolObservations: currentToolObservations.map((observation) => ({
        type: observation.type,
        context: observation.context,
      })),
      messages: contextMessages,
    });

    this.ensureSignalIsActive(signal);

    if (decision.action === "ignore") {
      return {
        action: "ignore",
        decision,
        effectiveConversationId,
        messageCount: contextMessages.length,
        responseMessageId: null,
        responseText: null,
        taskActionResults,
        triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      };
    }

    const effectiveReplyParameters = buildDecisionReplyParameters(
      triggerMessage,
      repliedMessage,
      decision.replyMode === "reply_to_message"
        ? decision.replyToMessageId
        : null
    );
    const delivery = new ChatResponseDelivery(this.dependencies, this.record, {
      ...(threadId == null ? {} : { threadId }),
      ...(effectiveReplyParameters == null
        ? {}
        : { replyParameters: effectiveReplyParameters }),
    });

    try {
      const selectedSticker =
        decision.sticker.send && decision.sticker.stickerId != null
          ? stickerCatalog.find(
              (sticker) => sticker.id === decision.sticker.stickerId
            ) ?? null
          : null;
      const fallbackSticker =
        selectedSticker == null &&
        isDirectStickerRequest(latestUserInputContext.normalizedInput)
          ? pickFallbackStickerForDirectRequest(stickerCatalog)
          : null;
      const resolvedSticker = selectedSticker ?? fallbackSticker;
      const effectiveResponseMode =
        decision.responseMode === "sticker_only" && resolvedSticker == null
          ? "text"
          : decision.responseMode === "text_with_sticker" &&
              resolvedSticker == null
            ? "text"
            : fallbackSticker != null
              ? "sticker_only"
            : decision.responseMode;

      if (effectiveResponseMode === "sticker_only" && resolvedSticker != null) {
        const stickerMessage = await delivery.deliverStickerOnly({
          conversationId: effectiveConversationId,
          fileId: resolvedSticker.fileId,
        });

        return {
          action: "respond",
          decision,
          effectiveConversationId,
          messageCount: contextMessages.length,
          responseText: null,
          responseMessageId: stickerMessage.message_id,
          taskActionResults,
          triggerTelegramMessageId: this.record.triggerTelegramMessageId,
        };
      }

      await delivery.start(effectiveConversationId);
      await this.throwIfCancellationRequested();

      const systemPrompt = await readChatPrompt();
      const contextModelMessages = await buildChatModelMessages({
        dependencies: this.dependencies,
        contextMessages,
        signal,
      });
      const responsePlanPrompt = buildResponsePlanPrompt({
        responseBrief: decision.responseBrief,
        responseMode: effectiveResponseMode,
        replyMode: decision.replyMode,
        replyToMessageId: decision.replyToMessageId,
        targetUserId: decision.targetUserId,
      });
      const inputEnvelopePrompt = buildChatInputEnvelope({
        latestRequest: latestUserInputContext,
        runtimeContext: runtimeContextPrompt,
        backlogSummary,
        responsePlan: responsePlanPrompt,
        toolContext: buildToolContextPrompt([
          ...priorToolObservations,
          ...currentToolObservations,
        ]),
      });
      const modelMessages: BaseMessage[] = [
        new SystemMessage(systemPrompt),
        new SystemMessage(inputEnvelopePrompt),
        ...contextModelMessages,
      ];
      const responseMessage = await this.dependencies.chatModel.invoke(
        modelMessages,
        {
          signal,
        }
      );
      const extractedResponseText = extractChatResponseText(
        responseMessage.content
      );
      const finalText =
        extractedResponseText.length > 0
          ? extractedResponseText
          : "I could not generate a response.";
      const deliveryResult = await delivery.deliverText({
        conversationId: effectiveConversationId,
        text: finalText,
      });

      if (effectiveResponseMode === "text_with_sticker" && resolvedSticker != null) {
        await delivery
          .sendSticker({
            conversationId: effectiveConversationId,
            fileId: resolvedSticker.fileId,
            parentTelegramMessageId: deliveryResult.controlMessageId,
          })
          .catch((error) => {
            logError("CHAT_STICKER_SEND", error, {
              taskId: this.record.id,
              chatId: this.record.chatId,
              conversationId: effectiveConversationId,
              stickerId: resolvedSticker.id,
            });
          });
      }

      return {
        action: "respond",
        decision,
        effectiveConversationId,
        messageCount: contextMessages.length,
        responseText: finalText,
        responseMessageId: deliveryResult.primaryMessageId,
        taskActionResults,
        triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      };
    } catch (error) {
      await delivery.fail({
        conversationId: effectiveConversationId,
        cancellationRequested: await this.cancellationRequested(),
        timedOut: this.isTimedOut(),
      });

      throw error;
    }
  }

  private parsePayload(): ChatTaskPayload {
    if (!this.record.payload) {
      return {};
    }

    try {
      const payload = JSON.parse(this.record.payload);
      return typeof payload === "object" && payload !== null
        ? (payload as ChatTaskPayload)
        : {};
    } catch {
      return {};
    }
  }

  private ensureSignalIsActive(signal: AbortSignal) {
    if (signal.aborted) {
      throw new Error(`Task ${this.record.id} aborted`);
    }
  }
}
