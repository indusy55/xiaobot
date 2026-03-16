import {
  telegramActionPlanSchema,
  type TelegramActionPlan,
  type TelegramContextPacket,
  type TelegramContextRef,
} from "../infra/ai/telegram-action-schema.js";

function getRef(packet: TelegramContextPacket, refId: string | null) {
  if (refId == null) {
    return null;
  }

  return packet.refs[refId] ?? null;
}

function assertRefKind(
  packet: TelegramContextPacket,
  refId: string | null,
  expectedKinds: TelegramContextRef["kind"][],
  label: string
) {
  if (refId == null) {
    return;
  }

  const ref = getRef(packet, refId);
  if (ref == null) {
    throw new Error(`${label} ref ${refId} does not exist in context packet`);
  }

  if (!expectedKinds.includes(ref.kind)) {
    throw new Error(
      `${label} ref ${refId} must be one of: ${expectedKinds.join(", ")}`
    );
  }
}

function assertWindowMembership(
  refId: string | null,
  allowedRefs: Set<string>,
  label: string
) {
  if (refId == null) {
    return;
  }

  if (!allowedRefs.has(refId)) {
    throw new Error(`${label} ref ${refId} is not allowed in this context window`);
  }
}

function collectReferencedRefIds(plan: TelegramActionPlan) {
  const refs = new Set<string>();

  if (plan.conversation.anchorRef != null) {
    refs.add(plan.conversation.anchorRef);
  }

  if (plan.conversation.branchRootRef != null) {
    refs.add(plan.conversation.branchRootRef);
  }

  for (const operation of plan.operations) {
    switch (operation.type) {
      case "send_message":
        if (operation.replyToRef != null) {
          refs.add(operation.replyToRef);
        }
        if (operation.quoteRef != null) {
          refs.add(operation.quoteRef);
        }
        break;
      case "send_sticker":
        if (operation.replyToRef != null) {
          refs.add(operation.replyToRef);
        }
        refs.add(operation.stickerRef);
        break;
      case "enqueue_task":
        if (operation.conversation.anchorRef != null) {
          refs.add(operation.conversation.anchorRef);
        }
        if (operation.conversation.branchRootRef != null) {
          refs.add(operation.conversation.branchRootRef);
        }
        break;
      case "cancel_task":
        break;
    }
  }

  return refs;
}

export function validateTelegramActionPlan(options: {
  packet: TelegramContextPacket;
  plan: TelegramActionPlan;
}) {
  const parsed = telegramActionPlanSchema.parse(options.plan);
  const packet = options.packet;
  const candidateReplyTargets = new Set(packet.windows.candidateReplyTargets);
  const candidateAnchors = new Set(packet.windows.candidateAnchors);
  const knownMessageRefs = new Set([
    ...packet.windows.conversation,
    ...packet.windows.recentChat,
    ...packet.windows.backlog,
  ]);

  if (parsed.operations.length > packet.runtime.limits.maxOperations) {
    throw new Error(
      `Action plan exceeds max operations limit ${packet.runtime.limits.maxOperations}`
    );
  }

  for (const refId of parsed.usedRefs) {
    if (!(refId in packet.refs)) {
      throw new Error(`usedRefs contains unknown ref ${refId}`);
    }
  }

  assertRefKind(
    packet,
    parsed.conversation.anchorRef,
    ["message"],
    "conversation.anchor"
  );
  assertRefKind(
    packet,
    parsed.conversation.branchRootRef,
    ["message"],
    "conversation.branchRoot"
  );

  if (parsed.disposition === "ignore" && parsed.operations.length > 0) {
    throw new Error("Ignore plans must not include operations");
  }

  if (parsed.disposition === "respond" && parsed.operations.length === 0) {
    throw new Error("Respond plans must include at least one operation");
  }

  assertWindowMembership(
    parsed.conversation.anchorRef,
    candidateAnchors,
    "conversation.anchor"
  );
  assertWindowMembership(
    parsed.conversation.branchRootRef,
    knownMessageRefs,
    "conversation.branchRoot"
  );

  for (const operation of parsed.operations) {
    switch (operation.type) {
      case "send_message":
        assertRefKind(packet, operation.replyToRef, ["message"], "replyTo");
        assertRefKind(packet, operation.quoteRef, ["message"], "quote");
        if (!packet.runtime.capabilities.canSendMessage) {
          throw new Error("Runtime cannot send messages");
        }
        if (
          operation.text.length > packet.runtime.limits.maxMessageLength
        ) {
          throw new Error(
            `send_message text exceeds max length ${packet.runtime.limits.maxMessageLength}`
          );
        }
        if (operation.text.trim().length === 0) {
          throw new Error("send_message text must not be empty");
        }
        if (operation.replyToRef != null) {
          if (!packet.runtime.capabilities.canReply) {
            throw new Error("Runtime cannot reply to messages");
          }
          assertWindowMembership(
            operation.replyToRef,
            candidateReplyTargets,
            "replyTo"
          );
        }
        if (operation.quoteRef != null) {
          if (!packet.runtime.capabilities.canQuote) {
            throw new Error("Runtime cannot send message quotes");
          }
          if (operation.replyToRef == null) {
            throw new Error("quoteRef requires replyToRef");
          }
          if (operation.quoteRef !== operation.replyToRef) {
            throw new Error("quoteRef must match replyToRef");
          }
          const quoteRef = getRef(packet, operation.quoteRef);
          if (quoteRef?.kind !== "message" || quoteRef.quote == null) {
            throw new Error(`quote ref ${operation.quoteRef} has no quote metadata`);
          }
        }
        break;
      case "send_sticker":
        assertRefKind(packet, operation.replyToRef, ["message"], "replyTo");
        assertRefKind(packet, operation.stickerRef, ["sticker"], "sticker");
        if (!packet.runtime.capabilities.canSendSticker) {
          throw new Error("Runtime cannot send stickers");
        }
        if (operation.replyToRef != null) {
          if (!packet.runtime.capabilities.canReply) {
            throw new Error("Runtime cannot reply to messages");
          }
          assertWindowMembership(
            operation.replyToRef,
            candidateReplyTargets,
            "replyTo"
          );
        }
        break;
      case "enqueue_task":
        if (!packet.runtime.capabilities.canEnqueueTask) {
          throw new Error("Runtime cannot enqueue tasks");
        }
        assertRefKind(
          packet,
          operation.conversation.anchorRef,
          ["message"],
          "enqueue.conversation.anchor"
        );
        assertRefKind(
          packet,
          operation.conversation.branchRootRef,
          ["message"],
          "enqueue.conversation.branchRoot"
        );
        assertWindowMembership(
          operation.conversation.anchorRef,
          candidateAnchors,
          "enqueue.conversation.anchor"
        );
        assertWindowMembership(
          operation.conversation.branchRootRef,
          knownMessageRefs,
          "enqueue.conversation.branchRoot"
        );
        break;
      case "cancel_task":
        if (!packet.runtime.capabilities.canCancelTask) {
          throw new Error("Runtime cannot cancel tasks");
        }
        break;
    }
  }

  const referencedRefs = collectReferencedRefIds(parsed);
  for (const refId of referencedRefs) {
    if (!parsed.usedRefs.includes(refId)) {
      throw new Error(`usedRefs must include referenced ref ${refId}`);
    }
  }

  return parsed;
}
