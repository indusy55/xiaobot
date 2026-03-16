import type { ChatDecision } from "../infra/ai/decision.js";
import {
  telegramActionPlanSchema,
  type TelegramActionPlan,
  type TelegramContextPacket,
  type TelegramContextRef,
} from "../infra/ai/telegram-action-schema.js";

function getRefEntries(packet: TelegramContextPacket) {
  return Object.entries(packet.refs) as Array<[string, TelegramContextRef]>;
}

export function findMessageRefByTelegramMessageId(
  packet: TelegramContextPacket,
  telegramMessageId: number | null
) {
  if (telegramMessageId == null) {
    return null;
  }

  for (const [refId, ref] of getRefEntries(packet)) {
    if (ref.kind === "message" && ref.telegramMessageId === telegramMessageId) {
      return refId;
    }
  }

  return null;
}

export function getTelegramMessageIdFromRef(
  packet: TelegramContextPacket,
  refId: string | null
) {
  if (refId == null) {
    return null;
  }

  const ref = packet.refs[refId];
  return ref?.kind === "message" ? ref.telegramMessageId : null;
}

export function findStickerRefByStickerId(
  packet: TelegramContextPacket,
  stickerId: number | null
) {
  if (stickerId == null) {
    return null;
  }

  for (const [refId, ref] of getRefEntries(packet)) {
    if (ref.kind === "sticker" && ref.stickerId === stickerId) {
      return refId;
    }
  }

  return null;
}

export function buildConversationPlanFromDecision(
  packet: TelegramContextPacket,
  decision: Pick<ChatDecision, "conversation">
) {
  const anchorRef = findMessageRefByTelegramMessageId(
    packet,
    decision.conversation.anchorMessageId
  );

  return {
    mode: decision.conversation.mode,
    anchorRef,
    branchRootRef: null,
  } as const;
}

export function buildTelegramActionPlanFromLegacyDecision(options: {
  packet: TelegramContextPacket;
  decision: ChatDecision;
}) {
  const { packet, decision } = options;
  const usedRefs = new Set<string>();
  const operations: TelegramActionPlan["operations"] = [];
  const conversation = buildConversationPlanFromDecision(packet, decision);
  const replyToRef =
    decision.replyMode === "reply_to_message"
      ? findMessageRefByTelegramMessageId(packet, decision.replyToMessageId)
      : null;

  if (replyToRef) {
    usedRefs.add(replyToRef);
  }
  if (conversation.anchorRef) {
    usedRefs.add(conversation.anchorRef);
  }

  for (const [index, taskAction] of decision.taskActions.entries()) {
    if (taskAction.type === "cancel_task") {
      operations.push({
        opId: `op_cancel_${index + 1}`,
        type: "cancel_task",
        scope: taskAction.scope,
      });
      continue;
    }

    const opConversation = {
      mode: taskAction.conversationMode.mode,
      anchorRef: findMessageRefByTelegramMessageId(
        packet,
        taskAction.conversationMode.anchorMessageId
      ),
      branchRootRef: null,
    } as const;

    if (opConversation.anchorRef) {
      usedRefs.add(opConversation.anchorRef);
    }

    operations.push({
      opId: `op_enqueue_${index + 1}`,
      type: "enqueue_task",
      taskKind: taskAction.taskKind,
      input: taskAction.userInput,
      conversation: opConversation,
    });
  }

  const stickerRef = decision.sticker.send
    ? findStickerRefByStickerId(packet, decision.sticker.stickerId)
    : null;
  if (stickerRef) {
    usedRefs.add(stickerRef);
  }

  if (decision.action === "respond") {
    if (decision.responseMode !== "sticker_only" && decision.responseText.trim().length > 0) {
      operations.push({
        opId: "op_send_message_1",
        type: "send_message",
        replyToRef,
        quoteRef: null,
        text: decision.responseText.trim(),
        parseMode: "MarkdownV2",
        disableWebPreview: false,
      });
    }

    if (stickerRef && decision.responseMode !== "text") {
      operations.push({
        opId: "op_send_sticker_1",
        type: "send_sticker",
        replyToRef,
        stickerRef,
      });
    }
  }

  return telegramActionPlanSchema.parse({
    disposition: decision.action === "ignore" ? "ignore" : "respond",
    conversation,
    operations:
      decision.action === "ignore"
        ? []
        : operations,
    usedRefs: [...usedRefs],
    notes: {
      summary: decision.responseBrief,
      reasoningBrief: decision.decisionNote,
    },
  });
}
