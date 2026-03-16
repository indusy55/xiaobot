import { assignConversationIdToMessage } from "../bot/conversation-store.js";
import { listStickerCatalog } from "../bot/sticker-store.js";
import { buildChatInputEnvelope } from "../infra/ai/input-envelope.js";
import { readChatPrompt } from "../infra/ai/prompt.js";
import { logError } from "../infra/error/index.js";
import { type WebSearchContext } from "../infra/search/searxng.js";
import type { ChatDecision } from "../infra/ai/decision.js";
import { BaseTask } from "./base.js";
import {
  buildChatModelMessages,
  buildToolContextPrompt,
} from "./chat-context.js";
import {
  buildTelegramContextPacket,
  summarizeTelegramContextPacket,
} from "./chat-context-packet.js";
import {
  buildTelegramActionPlanFromLegacyDecision,
  getTelegramMessageIdFromRef,
} from "./chat-action-plan.js";
import {
  decideChatNextStep,
  resolveEffectiveConversationId,
} from "./chat-decision.js";
import { planChatNextStep } from "./chat-plan.js";
import { validateTelegramActionPlan } from "./chat-plan-validator.js";
import { executeTelegramActionPlan } from "./chat-plan-executor.js";
import { runChatResearchLoop } from "./chat-research.js";
import {
  isDirectStickerRequest,
  pickFallbackStickerForDirectRequest,
} from "./chat-sticker.js";
import { prepareChatTurn } from "./chat-turn.js";
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
    const currentToolObservations = await runChatResearchLoop({
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
    const webSearchContext =
      latestSearchObservation?.type === "web_search"
        ? (latestSearchObservation.context as WebSearchContext | null)
        : null;
    const contextPacket = buildTelegramContextPacket({
      record: this.record,
      preparedTurn,
      availableStickers: stickerCatalog,
      priorToolObservations,
      currentToolObservations,
      allowTaskActions: payload.allowTaskActions !== false,
    });
    const systemPrompt = await readChatPrompt();
    const contextModelMessages = await buildChatModelMessages({
      dependencies: this.dependencies,
      contextMessages,
      signal,
      triggerTelegramMessageId: triggerMessage?.telegramMessageId ?? null,
      repliedTelegramMessageId: repliedMessage?.telegramMessageId ?? null,
    });
    const inputEnvelopePrompt = buildChatInputEnvelope({
      latestRequest: latestUserInputContext,
      runtimeContext: runtimeContextPrompt,
      backlogSummary,
      responsePlan: [
        "Response plan:",
        "- Decide whether to ignore or respond.",
        "- If responding, decide whether to send text, text_with_sticker, or sticker_only.",
        "- If sending text, put the exact final user-facing text into responseText.",
      ].join("\n"),
      toolContext: buildToolContextPrompt([
        ...priorToolObservations,
        ...currentToolObservations,
      ]),
    });
    const plannedAction = await planChatNextStep({
      record: this.record,
      decisionModel: this.dependencies.decisionModel,
      decisionTimeoutMs: this.dependencies.chatDecisionTimeoutMs,
      signal,
      systemPrompt,
      runtimeContextPrompt,
      inputEnvelopePrompt,
      packet: contextPacket,
    });
    const decision = plannedAction == null
      ? await decideChatNextStep({
          record: this.record,
          decisionModel: this.dependencies.decisionModel,
          allowTaskActions: payload.allowTaskActions !== false,
          decisionTimeoutMs: this.dependencies.chatDecisionTimeoutMs,
          signal,
          runtimeContextPrompt,
          systemPrompt,
          inputEnvelopePrompt,
          contextMessages,
          contextModelMessages,
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
        })
      : null;
    const legacySelectedSticker =
      decision?.sticker.send && decision.sticker.stickerId != null
        ? stickerCatalog.find((sticker) => sticker.id === decision.sticker.stickerId) ??
          null
        : null;
    const fallbackSticker =
      legacySelectedSticker == null &&
      plannedAction == null &&
      isDirectStickerRequest(latestUserInputContext.normalizedInput)
        ? pickFallbackStickerForDirectRequest(stickerCatalog)
        : null;
    const resolvedSticker = legacySelectedSticker ?? fallbackSticker;
    const fallbackDecision: ChatDecision =
      decision == null
        ? {
            action: "ignore" as const,
            responseMode: "text" as const,
            replyMode: "silent" as const,
            replyToMessageId: null,
            targetUserId: null,
            sticker: {
              send: false,
              stickerId: null,
              reason: "",
            },
            conversation: {
              mode: "continue" as const,
              anchorMessageId: null,
            },
            taskActions: [],
            responseBrief: "",
            responseText: "",
            decisionNote: "",
          }
        : resolvedSticker == null &&
            (decision.responseMode === "sticker_only" ||
              decision.responseMode === "text_with_sticker")
          ? {
              ...decision,
              responseMode: "text" as const,
              sticker: {
                ...decision.sticker,
                send: false,
                stickerId: null,
              },
            }
          : fallbackSticker != null
            ? {
                ...decision,
                responseMode: "sticker_only" as const,
                sticker: {
                  ...decision.sticker,
                  send: true,
                  stickerId: fallbackSticker.id,
                },
              }
            : decision;
    let plannerSource = plannedAction == null ? "legacy_decision" : "direct_action_plan";
    let actionPlan;
    if (plannedAction != null) {
      try {
        actionPlan = validateTelegramActionPlan({
          packet: contextPacket,
          plan: plannedAction,
        });
      } catch (error) {
        logError("CHAT_ACTION_PLAN_VALIDATE", error, {
          taskId: this.record.id,
          conversationId: this.record.conversationId,
          chatId: this.record.chatId,
        });
        plannerSource = "legacy_decision";
      }
    }

    if (actionPlan == null) {
      actionPlan = validateTelegramActionPlan({
        packet: contextPacket,
        plan: buildTelegramActionPlanFromLegacyDecision({
          packet: contextPacket,
          decision: fallbackDecision,
        }),
      });
    }
    const effectiveConversationId = resolveEffectiveConversationId({
      currentConversationId: this.record.conversationId,
      requestedConversation: {
        mode: actionPlan.conversation.mode,
        anchorMessageId: getTelegramMessageIdFromRef(
          contextPacket,
          actionPlan.conversation.anchorRef
        ),
      },
      fallbackAnchorMessageId:
        repliedMessage?.telegramMessageId ??
        this.record.triggerTelegramMessageId ??
        null,
      fallbackBranchRootMessageId:
        getTelegramMessageIdFromRef(
          contextPacket,
          actionPlan.conversation.branchRootRef
        ) ??
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

    await this.saveContextSnapshot({
      triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      decision,
      plannerSource,
      actionPlan,
      effectiveConversationId,
      webSearchContext,
      contextPacketSummary: summarizeTelegramContextPacket(contextPacket),
      toolObservations: currentToolObservations.map((observation) => ({
        type: observation.type,
        context: observation.context,
      })),
      messages: contextMessages,
    });

    this.ensureSignalIsActive(signal);

    if (actionPlan.disposition === "ignore") {
      return {
        action: "ignore",
        decision,
        actionPlan,
        effectiveConversationId,
        messageCount: contextMessages.length,
        responseMessageId: null,
        responseText: null,
        taskActionResults: [],
        triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      };
    }
    this.ensureSignalIsActive(signal);
    const execution = await executeTelegramActionPlan({
      plan: actionPlan,
      packet: contextPacket,
      effectiveConversationId,
      ...(threadId == null ? {} : { threadId }),
      dependencies: {
        api: this.dependencies.api,
        taskRuntime: this.dependencies.taskRuntime,
      },
      record: this.record,
      getFailureState: async () => ({
        cancellationRequested: await this.cancellationRequested(),
        timedOut: this.isTimedOut(),
      }),
    });

    return {
      action: "respond",
      decision,
      actionPlan,
      effectiveConversationId,
      messageCount: contextMessages.length,
      responseText: execution.responseText,
      responseMessageId: execution.responseMessageId,
      taskActionResults: execution.operationResults.filter(
        (result) =>
          result.type === "cancel_task" || result.type === "enqueue_task"
      ),
      triggerTelegramMessageId: this.record.triggerTelegramMessageId,
    };
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
