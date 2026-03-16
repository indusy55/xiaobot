import { extractMessageQuote } from "../bot/message-quote.js";
import type { StickerCatalogEntry } from "../bot/sticker-store.js";
import {
  getAnchorMessageId,
  getBranchRootMessageId,
} from "../bot/conversation.js";
import {
  telegramContextPacketSchema,
  type TelegramContextPacket,
  type TelegramMessageRef,
} from "../infra/ai/telegram-action-schema.js";
import { summarizeTelegramMessageMedia } from "../infra/media/telegram-media.js";
import type { PreparedChatTurn } from "./chat-turn.js";
import type { ChatToolObservationRecord } from "./chat-context.js";
import type { TaskRecord } from "./types.js";

const WEB_SEARCH_TTL_SEC = 15 * 60;
const MAX_PACKET_MESSAGE_TEXT = 4000;

function clipText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function cleanText(text: string | null | undefined) {
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIso(value: number) {
  return new Date(value).toISOString();
}

function normalizeChatType(chatType: string) {
  switch (chatType) {
    case "private":
    case "group":
    case "supergroup":
    case "channel":
      return chatType;
    default:
      return "group" as const;
  }
}

function determineConversationScope(conversationId: string) {
  if (conversationId.startsWith("private:")) {
    return "private" as const;
  }

  if (getBranchRootMessageId(conversationId) != null) {
    return "chat_branch" as const;
  }

  if (getAnchorMessageId(conversationId) != null) {
    return "chat_anchor" as const;
  }

  return "chat" as const;
}

function buildDisplayName(message: {
  fromFirstName: string | null;
  fromLastName: string | null;
  fromUsername: string | null;
  fromId: string | null;
  role?: string;
}) {
  const fullName = [message.fromFirstName, message.fromLastName]
    .map((value) => cleanText(value))
    .filter((value): value is string => value != null)
    .join(" ")
    .trim();
  const username = cleanText(message.fromUsername);

  if (fullName.length > 0 && username) {
    return `${fullName} (@${username})`;
  }

  if (fullName.length > 0) {
    return fullName;
  }

  if (username) {
    return `@${username}`;
  }

  if (message.fromId) {
    return message.role === "assistant"
      ? `bot#${message.fromId}`
      : `user#${message.fromId}`;
  }

  return message.role === "assistant" ? "assistant" : "unknown user";
}

function buildStickerTags(sticker: StickerCatalogEntry) {
  const normalizedTitle = sticker.setTitle.toLowerCase();
  const normalizedSetName = sticker.setName.toLowerCase();
  const splitWords = `${normalizedSetName} ${normalizedTitle}`
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);

  return [
    ...new Set(
      [
        normalizedSetName,
        normalizedTitle,
        sticker.emoji?.trim(),
        ...splitWords,
      ].filter((value): value is string => typeof value === "string" && value.length > 0)
    ),
  ].slice(0, 32);
}

function summarizeWebSearchObservation(observation: ChatToolObservationRecord) {
  if (observation.type !== "web_search" || observation.context == null) {
    return "Web search observation";
  }

  const topTitle = observation.context.results[0]?.title?.trim();
  const answer = cleanText(observation.context.answer);

  return clipText(
    [
      `Search query: ${observation.context.query}`,
      answer ? `Answer: ${answer}` : null,
      topTitle ? `Top result: ${topTitle}` : null,
    ]
      .filter((value): value is string => value != null)
      .join("\n"),
    4000
  );
}

function buildMessageContent(message: PreparedChatTurn["contextMessages"][number]) {
  const content: TelegramMessageRef["content"] = [];
  const text = cleanText(message.textContent);
  const mediaSummary = summarizeTelegramMessageMedia({
    rawMessage: message.rawMessage,
    contentType: message.contentType,
  });

  if (text) {
    content.push({
      type: "text",
      text: clipText(text, MAX_PACKET_MESSAGE_TEXT),
    });
  }

  if (mediaSummary) {
    content.push({
      type: "text",
      text: clipText(mediaSummary.summary, MAX_PACKET_MESSAGE_TEXT),
    });
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: `[${message.contentType}]`,
    });
  }

  return content;
}

export function buildTelegramContextPacket(options: {
  record: Pick<TaskRecord, "chatId" | "conversationId" | "triggerTelegramMessageId">;
  preparedTurn: Pick<
    PreparedChatTurn,
    | "threadId"
    | "contextMessages"
    | "recentChatMessages"
    | "triggerMessage"
    | "repliedMessage"
  >;
  availableStickers: StickerCatalogEntry[];
  priorToolObservations: ChatToolObservationRecord[];
  currentToolObservations: ChatToolObservationRecord[];
  allowTaskActions: boolean;
  now?: number;
}) {
  const {
    record,
    preparedTurn,
    availableStickers,
    priorToolObservations,
    currentToolObservations,
    allowTaskActions,
    now = Date.now(),
  } = options;
  const chatRef = "chat_main";
  const conversationRef = "conversation_active";
  const threadRef =
    preparedTurn.threadId == null ? null : (`thread_${preparedTurn.threadId}` as const);
  const refs: TelegramContextPacket["refs"] = {
    [chatRef]: {
      kind: "chat",
      telegramChatId: record.chatId,
      title:
        preparedTurn.triggerMessage?.chatTitle ??
        preparedTurn.repliedMessage?.chatTitle ??
        preparedTurn.contextMessages.at(-1)?.chatTitle ??
        null,
    },
    [conversationRef]: {
      kind: "conversation",
      conversationId: record.conversationId,
      scope: determineConversationScope(record.conversationId),
    },
  };

  if (threadRef != null) {
    refs[threadRef] = {
      kind: "thread",
      telegramThreadId: preparedTurn.threadId as number,
    };
  }

  const messageRefById = new Map<number, string>();
  const messageRefByTelegramMessageId = new Map<number, string>();
  const seenUserRefs = new Map<string, string>();

  const allMessages = [
    ...preparedTurn.contextMessages,
    ...preparedTurn.recentChatMessages.filter(
      (message) =>
        !preparedTurn.contextMessages.some((existing) => existing.id === message.id)
    ),
  ];

  for (const message of allMessages) {
    const authorKey =
      cleanText(message.fromId) ??
      cleanText(message.fromUsername) ??
      `message_author_${message.id}`;
    let authorRef = seenUserRefs.get(authorKey) ?? null;

    if (authorRef == null) {
      authorRef =
        cleanText(message.fromId) != null
          ? `user_${message.fromId}`
          : `user_message_${message.id}`;
      seenUserRefs.set(authorKey, authorRef);
      refs[authorRef] = {
        kind: "user",
        telegramUserId: message.fromId ?? authorRef,
        username: cleanText(message.fromUsername),
        displayName: buildDisplayName(message),
        isBot: message.role === "assistant",
      };
    }

    const messageRef = `message_${message.id}`;
    messageRefById.set(message.id, messageRef);
    if (message.telegramMessageId != null) {
      messageRefByTelegramMessageId.set(message.telegramMessageId, messageRef);
    }

    refs[messageRef] = {
      kind: "message",
      telegramMessageId: message.telegramMessageId,
      role: message.role,
      authorRef,
      chatRef,
      threadRef,
      conversationRef,
      replyToRef: null,
      parentRef: null,
      branchRootRef: null,
      createdAtIso: toIso(message.createdAt),
      content: buildMessageContent(message),
      quote: (() => {
        const quote = extractMessageQuote(message.rawMessage);
        if (!quote) {
          return null;
        }

        return {
          text: quote.text,
          offset: quote.position ?? null,
          length: quote.text.length,
        };
      })(),
    };
  }

  for (const message of allMessages) {
    const messageRef = messageRefById.get(message.id);
    if (!messageRef) {
      continue;
    }

    const recordRef = refs[messageRef];
    if (recordRef?.kind !== "message") {
      continue;
    }

    recordRef.replyToRef =
      message.replyToTelegramMessageId != null
        ? (messageRefByTelegramMessageId.get(message.replyToTelegramMessageId) ?? null)
        : null;
    recordRef.parentRef =
      message.parentMessageId != null
        ? (messageRefById.get(message.parentMessageId) ?? null)
        : null;
    recordRef.branchRootRef =
      message.referenceMessageId != null
        ? (messageRefById.get(message.referenceMessageId) ?? null)
        : null;
  }

  const stickerRefs = availableStickers.map((sticker) => {
    const refId = `sticker_${sticker.id}`;
    refs[refId] = {
      kind: "sticker",
      stickerId: sticker.id,
      telegramFileId: sticker.fileId,
      setName: sticker.setName,
      setTitle: sticker.setTitle,
      emoji: sticker.emoji,
      tags: buildStickerTags(sticker),
      isAnimated: sticker.isAnimated,
      isVideo: sticker.isVideo,
    };
    return refId;
  });

  const toolRefs = [...priorToolObservations, ...currentToolObservations].map(
    (observation, index) => {
      const refId = `tool_${observation.type}_${index + 1}`;
      refs[refId] = {
        kind: "tool_result",
        toolType: observation.type,
        createdAtIso: toIso(now),
        ttlSec: observation.type === "web_search" ? WEB_SEARCH_TTL_SEC : null,
        summary: summarizeWebSearchObservation(observation),
        payload: observation.context,
      };
      return refId;
    }
  );

  const conversationWindow = preparedTurn.contextMessages
    .map((message) => messageRefById.get(message.id))
    .filter((value): value is string => value != null);
  const recentChatWindow = preparedTurn.recentChatMessages
    .map((message) => messageRefById.get(message.id))
    .filter((value): value is string => value != null);
  const candidateReplyTargets = preparedTurn.contextMessages
    .filter((message) => message.telegramMessageId != null)
    .map((message) => messageRefById.get(message.id))
    .filter((value): value is string => value != null);
  const candidateAnchors = preparedTurn.contextMessages
    .filter((message) => message.role !== "tool")
    .map((message) => messageRefById.get(message.id))
    .filter((value): value is string => value != null);

  const packet = {
    meta: {
      platform: "telegram" as const,
      chatRef,
      conversationRef,
      triggerRef:
        preparedTurn.triggerMessage != null
          ? (messageRefById.get(preparedTurn.triggerMessage.id) ?? null)
          : null,
      repliedRef:
        preparedTurn.repliedMessage != null
          ? (messageRefById.get(preparedTurn.repliedMessage.id) ?? null)
          : null,
      nowIso: toIso(now),
      schemaVersion: 1 as const,
    },
    runtime: {
      chatType: normalizeChatType(
        preparedTurn.triggerMessage?.chatType ??
          preparedTurn.repliedMessage?.chatType ??
          preparedTurn.contextMessages.at(-1)?.chatType ??
          "group"
      ),
      threadRef,
      botUserRef: null,
      capabilities: {
        canSendMessage: true,
        canSendSticker: stickerRefs.length > 0,
        canReply: true,
        canQuote: true,
        canEnqueueTask: allowTaskActions,
        canCancelTask: allowTaskActions,
      },
      limits: {
        maxMessageLength: 4096,
        maxOperations: 4,
        maxReplyDepth: 20,
      },
    },
    refs,
    windows: {
      conversation: conversationWindow,
      recentChat: recentChatWindow,
      backlog: [],
      candidateReplyTargets,
      candidateAnchors,
      availableStickers: stickerRefs,
      reusableToolResults: toolRefs,
    },
  } satisfies TelegramContextPacket;

  return telegramContextPacketSchema.parse(packet);
}

export function summarizeTelegramContextPacket(packet: TelegramContextPacket) {
  const refCountByKind = Object.values(packet.refs).reduce<Record<string, number>>(
    (acc, ref) => {
      acc[ref.kind] = (acc[ref.kind] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return {
    schemaVersion: packet.meta.schemaVersion,
    chatRef: packet.meta.chatRef,
    conversationRef: packet.meta.conversationRef,
    triggerRef: packet.meta.triggerRef,
    repliedRef: packet.meta.repliedRef,
    refCountByKind,
    windowSizes: {
      conversation: packet.windows.conversation.length,
      recentChat: packet.windows.recentChat.length,
      backlog: packet.windows.backlog.length,
      candidateReplyTargets: packet.windows.candidateReplyTargets.length,
      candidateAnchors: packet.windows.candidateAnchors.length,
      availableStickers: packet.windows.availableStickers.length,
      reusableToolResults: packet.windows.reusableToolResults.length,
    },
    capabilities: packet.runtime.capabilities,
  };
}
