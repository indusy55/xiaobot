import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { TaskContextMessage } from "../../tasks/types.js";

const stickerIntentSchema = z.object({
  send: z.boolean(),
  stickerId: z.number().int().positive().nullable(),
  reason: z.string().max(200),
});

const responseModeSchema = z.enum([
  "text",
  "text_with_sticker",
  "sticker_only",
]);

const conversationModeSchema = z.object({
  mode: z.enum(["continue", "new", "fork_from_message"]),
  anchorMessageId: z.number().int().positive().nullable(),
});

const cancelTaskActionSchema = z.object({
  type: z.literal("cancel_task"),
  scope: z.enum(["latest_in_conversation", "latest_in_chat"]),
});

const enqueueTaskActionSchema = z.object({
  type: z.literal("enqueue_task"),
  taskKind: z.literal("chat"),
  userInput: z.string().max(2000),
  conversationMode: conversationModeSchema,
});

export const webSearchDecisionSchema = z.object({
  shouldSearch: z.boolean(),
  query: z.string().max(256).nullable(),
  reason: z.string().max(200),
});

export const chatDecisionSchema = z.object({
  action: z.enum(["respond", "ignore"]),
  responseMode: responseModeSchema,
  replyMode: z.enum(["reply_to_message", "send_message", "silent"]),
  replyToMessageId: z.number().int().positive().nullable(),
  targetUserId: z.string().nullable(),
  sticker: stickerIntentSchema,
  conversation: conversationModeSchema,
  taskActions: z
    .array(z.discriminatedUnion("type", [cancelTaskActionSchema, enqueueTaskActionSchema]))
    .max(3),
  responseBrief: z.string().max(500),
  responseText: z.string().max(12000),
  decisionNote: z.string().max(300),
});

export type ChatDecision = z.infer<typeof chatDecisionSchema>;
export type ChatTaskAction = ChatDecision["taskActions"][number];
export type WebSearchDecision = z.infer<typeof webSearchDecisionSchema>;
export interface ChatDecisionStickerCandidate {
  id: number;
  emoji: string | null;
  setName: string;
  setTitle: string;
  isAnimated: boolean;
  isVideo: boolean;
}

interface BuildDecisionMessagesOptions {
  runtimeContextPrompt: string;
  systemPrompt?: string;
  inputEnvelopePrompt?: string;
  conversationId: string;
  conversationMessages: TaskContextMessage[];
  contextModelMessages?: BaseMessage[];
  recentChatMessages: TaskContextMessage[];
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
  availableStickers?: ChatDecisionStickerCandidate[];
}

interface SanitizeDecisionOptions {
  allowTaskActions: boolean;
  triggerTelegramMessageId: number | null;
  triggerUserId: string | null;
  repliedTelegramMessageId: number | null;
  conversationMessages: TaskContextMessage[];
  recentChatMessages: TaskContextMessage[];
  availableStickerIds?: Set<number>;
}

interface SanitizeWebSearchDecisionOptions {
  fallbackQuery: string | null;
}

const CHAT_DECISION_SYSTEM_PROMPT = [
  "Decide how the Telegram bot should react to the latest message.",
  "Base the decision on the latest request and the provided chat context.",
  "Be conservative in group chats and practical in private chats.",
  "Do not invent message ids or user ids.",
  "Use the exact enum values from the schema. Do not output aliases, translations, or prose in enum fields.",
  "responseText must be the exact final user-facing text to send.",
  "If action is ignore, responseText must be an empty string.",
  "If responseMode is sticker_only, responseText must be an empty string.",
  "If responseMode is text_with_sticker, responseText must contain only the text message. The runtime sends the sticker separately.",
  "Do not output placeholders such as [sticker], [贴纸], [image], or [photo].",
  "Return exactly one JSON object with these fields:",
  "- action",
  "- responseMode",
  "- replyMode",
  "- replyToMessageId",
  "- targetUserId",
  "- sticker",
  "- conversation",
  "- taskActions",
  "- responseBrief",
  "- responseText",
  "- decisionNote",
].join("\n");

function cleanValue(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDisplayName(message: Pick<
  TaskContextMessage,
  "fromFirstName" | "fromLastName" | "fromUsername" | "fromId"
>) {
  const firstName = cleanValue(message.fromFirstName);
  const lastName = cleanValue(message.fromLastName);
  const username = cleanValue(message.fromUsername);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

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
    return `user#${message.fromId}`;
  }

  return "unknown user";
}

function toExcerpt(message: TaskContextMessage) {
  const text = cleanValue(message.textContent);
  if (!text) {
    return `[${message.contentType}]`;
  }

  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function serializeMessage(message: TaskContextMessage) {
  return {
    message_id: message.telegramMessageId,
    role: message.role,
    from_user_id: message.fromId,
    from_name: formatDisplayName(message),
    reply_to_message_id: message.replyToTelegramMessageId,
    text: toExcerpt(message),
    created_at: message.createdAt,
  };
}

function buildParticipants(messages: TaskContextMessage[]) {
  const seen = new Map<string, TaskContextMessage>();

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const key =
      cleanValue(message.fromId) ??
      cleanValue(message.fromUsername) ??
      `message:${message.id}`;

    if (!seen.has(key)) {
      seen.set(key, message);
    }
  }

  return [...seen.values()].map((message) => ({
    user_id: message.fromId,
    username: message.fromUsername,
    display_name: formatDisplayName(message),
    language_code: message.fromLanguageCode,
  }));
}

function getCandidateReplyMessageIds(messages: TaskContextMessage[]) {
  return messages
    .map((message) => message.telegramMessageId)
    .filter((messageId): messageId is number => typeof messageId === "number");
}

function buildStickerCandidatesPayload(
  stickers: ChatDecisionStickerCandidate[] | undefined
) {
  if (!stickers || stickers.length === 0) {
    return [];
  }

  return stickers.slice(0, 24).map((sticker) => ({
    id: sticker.id,
    emoji: sticker.emoji,
    set_name: sticker.setName,
    set_title: sticker.setTitle,
    is_animated: sticker.isAnimated,
    is_video: sticker.isVideo,
  }));
}

function sanitizeStickerIntent(
  sticker: ChatDecision["sticker"],
  allowedStickerIds: Set<number>
) {
  const stickerId =
    sticker.send &&
    sticker.stickerId != null &&
    allowedStickerIds.has(sticker.stickerId)
      ? sticker.stickerId
      : null;

  return {
    send: sticker.send && stickerId != null,
    stickerId,
    reason: sticker.reason.trim(),
  };
}

function sanitizeResponseMode(
  responseMode: ChatDecision["responseMode"],
  sticker: ReturnType<typeof sanitizeStickerIntent>
) {
  if (!sticker.send) {
    return "text" as const;
  }

  if (responseMode === "sticker_only") {
    return "sticker_only" as const;
  }

  return "text_with_sticker" as const;
}

function isPlaceholderResponseText(text: string) {
  return /^\[(sticker|贴纸|image|photo|图片)\]$/iu.test(text.trim());
}

function sanitizeResponseText(options: {
  action: ChatDecision["action"];
  responseMode: ChatDecision["responseMode"];
  responseText: string;
  responseBrief: string;
}) {
  if (
    options.action === "ignore" ||
    options.responseMode === "sticker_only"
  ) {
    return "";
  }

  const primaryText = options.responseText.trim();
  if (primaryText.length > 0 && !isPlaceholderResponseText(primaryText)) {
    return primaryText;
  }

  const briefText = options.responseBrief.trim();
  if (briefText.length > 0 && !isPlaceholderResponseText(briefText)) {
    return briefText;
  }

  return "I could not generate a response.";
}

function sanitizeConversationMode(
  conversation: ChatDecision["conversation"],
  options: SanitizeDecisionOptions,
  allowedReplyMessageIds: Set<number>
) {
  const fallbackAnchorMessageId =
    options.repliedTelegramMessageId ?? options.triggerTelegramMessageId ?? null;
  const anchorMessageId =
    typeof conversation.anchorMessageId === "number" &&
    allowedReplyMessageIds.has(conversation.anchorMessageId)
      ? conversation.anchorMessageId
      : fallbackAnchorMessageId;

  switch (conversation.mode) {
    case "continue":
      return {
        mode: "continue" as const,
        anchorMessageId: null,
      };
    case "new":
      return {
        mode: "new" as const,
        anchorMessageId:
          options.triggerTelegramMessageId != null &&
          allowedReplyMessageIds.has(options.triggerTelegramMessageId)
            ? options.triggerTelegramMessageId
            : anchorMessageId,
      };
    case "fork_from_message":
      return {
        mode: "fork_from_message" as const,
        anchorMessageId,
      };
  }
}

function sanitizeTaskActions(
  decision: ChatDecision,
  options: SanitizeDecisionOptions,
  allowedReplyMessageIds: Set<number>
) {
  if (!options.allowTaskActions) {
    return [];
  }

  return decision.taskActions.reduce<ChatDecision["taskActions"]>((acc, taskAction) => {
    if (taskAction.type === "cancel_task") {
      acc.push(taskAction);
      return acc;
    }

    const userInput = taskAction.userInput.trim();
    if (userInput.length === 0) {
      return acc;
    }

    acc.push({
      ...taskAction,
      userInput,
      conversationMode: sanitizeConversationMode(
        taskAction.conversationMode,
        options,
        allowedReplyMessageIds
      ),
    });

    return acc;
  }, []);
}

export function buildChatDecisionMessages(
  options: BuildDecisionMessagesOptions
): BaseMessage[] {
  const {
    runtimeContextPrompt,
    systemPrompt,
    inputEnvelopePrompt,
    conversationId,
    conversationMessages,
    contextModelMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
    availableStickers,
  } = options;
  const payload = {
    conversation_id: conversationId,
    chat: triggerMessage
      ? {
          type: triggerMessage.chatType,
          title: triggerMessage.chatTitle,
        }
      : null,
    trigger_message_id: triggerMessage?.telegramMessageId ?? null,
    replied_message_id: repliedMessage?.telegramMessageId ?? null,
    candidate_reply_message_ids: getCandidateReplyMessageIds(conversationMessages),
    trigger_message: triggerMessage ? serializeMessage(triggerMessage) : null,
    replied_message: repliedMessage ? serializeMessage(repliedMessage) : null,
    available_stickers: buildStickerCandidatesPayload(availableStickers),
    participants: buildParticipants(recentChatMessages),
    current_conversation_messages: conversationMessages.map(serializeMessage),
    recent_chat_messages: recentChatMessages.slice(-12).map(serializeMessage),
  };

  return [
    new SystemMessage(CHAT_DECISION_SYSTEM_PROMPT),
    ...(systemPrompt ? [new SystemMessage(systemPrompt)] : []),
    new SystemMessage(runtimeContextPrompt),
    ...(inputEnvelopePrompt ? [new SystemMessage(inputEnvelopePrompt)] : []),
    ...(contextModelMessages ?? []),
    new HumanMessage(
      `Decide the next Telegram bot action for the latest message.\nContext JSON:\n${JSON.stringify(
        payload,
        null,
        2
      )}`
    ),
  ];
}

export function sanitizeChatDecision(
  decision: ChatDecision,
  options: SanitizeDecisionOptions
) {
  const allowedReplyMessageIds = new Set(
    getCandidateReplyMessageIds(options.conversationMessages)
  );
  const allowedUserIds = new Set(
    options.recentChatMessages
      .map((message) => cleanValue(message.fromId))
      .filter((value): value is string => value != null)
  );
  const responseBrief = decision.responseBrief.trim();
  const sticker = sanitizeStickerIntent(
    decision.sticker,
    options.availableStickerIds ?? new Set<number>()
  );
  const responseMode = sanitizeResponseMode(decision.responseMode, sticker);
  const responseText = sanitizeResponseText({
    action: decision.action,
    responseMode,
    responseText: decision.responseText,
    responseBrief,
  });
  const targetUserId =
    decision.targetUserId && allowedUserIds.has(decision.targetUserId)
      ? decision.targetUserId
      : null;
  const conversation = sanitizeConversationMode(
    decision.conversation,
    options,
    allowedReplyMessageIds
  );
  const taskActions = sanitizeTaskActions(
    decision,
    options,
    allowedReplyMessageIds
  );

  if (decision.action === "ignore") {
    return {
      ...decision,
      responseMode: "text" as const,
      replyMode: "silent" as const,
      replyToMessageId: null,
      targetUserId,
      sticker: {
        send: false,
        stickerId: null,
        reason: sticker.reason,
      },
      conversation,
      taskActions,
      responseBrief,
      responseText: "",
    };
  }

  let replyMode = decision.replyMode;
  let replyToMessageId =
    typeof decision.replyToMessageId === "number" &&
    allowedReplyMessageIds.has(decision.replyToMessageId)
      ? decision.replyToMessageId
      : null;

  if (replyMode === "silent") {
    replyMode =
      options.triggerTelegramMessageId == null ? "send_message" : "reply_to_message";
  }

  if (replyMode === "reply_to_message" && replyToMessageId == null) {
    replyToMessageId =
      options.triggerTelegramMessageId != null &&
      allowedReplyMessageIds.has(options.triggerTelegramMessageId)
        ? options.triggerTelegramMessageId
        : null;
  }

  if (replyMode === "reply_to_message" && replyToMessageId == null) {
    replyMode = "send_message";
  }

  return {
    ...decision,
    responseMode,
    replyMode,
    replyToMessageId,
    targetUserId,
    sticker,
    conversation,
    taskActions,
    responseBrief,
    responseText,
  };
}

export function sanitizeWebSearchDecision(
  decision: WebSearchDecision,
  options: SanitizeWebSearchDecisionOptions
) {
  const query = cleanValue(decision.query) ?? options.fallbackQuery;

  if (!decision.shouldSearch || query == null) {
    return {
      ...decision,
      shouldSearch: false,
      query: null,
    };
  }

  return {
    ...decision,
    shouldSearch: true,
    query: query.slice(0, 256),
  };
}

export function buildFallbackChatDecision(triggerTelegramMessageId: number | null): ChatDecision {
  return {
    action: "respond",
    responseMode: "text",
    replyMode:
      triggerTelegramMessageId == null ? "send_message" : "reply_to_message",
    replyToMessageId: triggerTelegramMessageId,
    targetUserId: null,
    sticker: {
      send: false,
      stickerId: null,
      reason: "Fallback decision",
    },
    conversation: {
      mode: "continue",
      anchorMessageId: null,
    },
    taskActions: [],
    responseBrief: "I could not generate a response.",
    responseText: "I could not generate a response.",
    decisionNote: "Fallback decision",
  };
}

function extractTextContent(content: AIMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("");
}

function findJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Decision response did not contain a JSON object");
  }

  return text.slice(start, end + 1);
}

function normalizeEnumValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function normalizeAction(value: unknown) {
  const normalized = normalizeEnumValue(value);
  switch (normalized) {
    case "respond":
    case "reply":
    case "answer":
    case "send":
    case "回复":
    case "回答":
    case "发送":
      return "respond" as const;
    case "ignore":
    case "silent":
    case "skip":
    case "none":
    case "忽略":
    case "跳过":
    case "不回复":
      return "ignore" as const;
    default:
      return "respond" as const;
  }
}

function normalizeResponseMode(value: unknown) {
  const normalized = normalizeEnumValue(value);
  switch (normalized) {
    case "text":
    case "message":
    case "text_only":
    case "文本":
    case "纯文本":
      return "text" as const;
    case "text_with_sticker":
    case "text+sticker":
    case "message_with_sticker":
    case "mixed":
    case "图文":
    case "文本加贴纸":
    case "文字加贴纸":
      return "text_with_sticker" as const;
    case "sticker_only":
    case "sticker":
    case "only_sticker":
    case "send_sticker":
    case "贴纸":
    case "只发贴纸":
      return "sticker_only" as const;
    default:
      return "text" as const;
  }
}

function normalizeReplyMode(value: unknown) {
  const normalized = normalizeEnumValue(value);
  switch (normalized) {
    case "reply_to_message":
    case "reply":
    case "reply_to":
    case "回复":
    case "回复消息":
      return "reply_to_message" as const;
    case "send_message":
    case "send":
    case "message":
    case "发送":
    case "发送消息":
      return "send_message" as const;
    case "silent":
    case "ignore":
    case "none":
    case "静默":
    case "不回复":
      return "silent" as const;
    default:
      return "send_message" as const;
  }
}

function normalizeConversation(
  value: unknown
): ChatDecision["conversation"] | unknown {
  if (typeof value === "string") {
    const normalized = normalizeEnumValue(value);
    if (
      normalized === "continue" ||
      normalized === "new" ||
      normalized === "fork_from_message" ||
      normalized === "继续"
    ) {
      return {
        mode: normalized === "继续" ? "continue" : normalized,
        anchorMessageId: null,
      };
    }

    if (
      normalized === "fork" ||
      normalized === "分叉" ||
      normalized === "fork_from" ||
      normalized === "branch"
    ) {
      return {
        mode: "fork_from_message" as const,
        anchorMessageId: null,
      };
    }

    if (
      normalized === "new" ||
      normalized === "新对话" ||
      normalized === "重新开始"
    ) {
      return {
        mode: "new" as const,
        anchorMessageId: null,
      };
    }

    return {
      mode: "continue" as const,
      anchorMessageId: null,
    };
  }

  if (typeof value !== "object" || value === null) {
    return {
      mode: "continue" as const,
      anchorMessageId: null,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    mode: (() => {
      const normalizedMode = normalizeEnumValue(record.mode);
      if (
        normalizedMode === "continue" ||
        normalizedMode === "继续" ||
        normalizedMode == null
      ) {
        return "continue" as const;
      }

      if (
        normalizedMode === "new" ||
        normalizedMode === "新对话" ||
        normalizedMode === "重新开始"
      ) {
        return "new" as const;
      }

      if (
        normalizedMode === "fork" ||
        normalizedMode === "fork_from_message" ||
        normalizedMode === "分叉" ||
        normalizedMode === "branch"
      ) {
        return "fork_from_message" as const;
      }

      return "continue" as const;
    })(),
    anchorMessageId:
      typeof record.anchorMessageId === "number"
        ? record.anchorMessageId
        : typeof record.anchor_message_id === "number"
          ? record.anchor_message_id
          : typeof record.anchorMessageId === "string" &&
              /^\d+$/.test(record.anchorMessageId)
            ? Number(record.anchorMessageId)
            : typeof record.anchor_message_id === "string" &&
                /^\d+$/.test(record.anchor_message_id)
              ? Number(record.anchor_message_id)
          : null,
  };
}

function normalizeStickerIntent(
  value: unknown,
  responseMode: unknown
): ChatDecision["sticker"] | unknown {
  const normalizedResponseMode = normalizeResponseMode(responseMode);

  if (typeof value === "boolean") {
    return {
      send: value,
      stickerId: null,
      reason: "",
    };
  }

  if (typeof value === "number") {
    return {
      send: true,
      stickerId: value,
      reason: "",
    };
  }

  if (typeof value !== "object" || value === null) {
    return {
      send: normalizedResponseMode !== "text",
      stickerId: null,
      reason: "",
    };
  }

  const record = value as Record<string, unknown>;
  const rawStickerId =
    typeof record.stickerId === "number"
      ? record.stickerId
      : typeof record.sticker_id === "number"
        ? record.sticker_id
        : typeof record.stickerId === "string" && /^\d+$/.test(record.stickerId)
          ? Number(record.stickerId)
          : typeof record.sticker_id === "string" &&
              /^\d+$/.test(record.sticker_id)
            ? Number(record.sticker_id)
        : null;
  const rawSend =
    typeof record.send === "boolean"
      ? record.send
      : rawStickerId != null || normalizedResponseMode !== "text";

  return {
    send: rawSend,
    stickerId: rawStickerId,
    reason:
      typeof record.reason === "string"
        ? record.reason
        : typeof record.note === "string"
          ? record.note
          : "",
  };
}

function normalizeTaskActions(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeNullableNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function normalizeRawChatDecision(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const action = normalizeAction(record.action);
  const responseMode = normalizeResponseMode(record.responseMode);

  return {
    action,
    responseMode,
    replyMode: normalizeReplyMode(record.replyMode),
    replyToMessageId:
      normalizeNullableNumber(record.replyToMessageId) ??
      normalizeNullableNumber(record.reply_to_message_id),
    targetUserId:
      normalizeNullableString(record.targetUserId) ??
      normalizeNullableString(record.target_user_id),
    sticker: normalizeStickerIntent(record.sticker, responseMode),
    conversation: normalizeConversation(record.conversation),
    taskActions: normalizeTaskActions(record.taskActions ?? record.task_actions),
    responseBrief:
      normalizeString(record.responseBrief) ||
      normalizeString(record.response_brief),
    responseText:
      normalizeString(record.responseText) ||
      normalizeString(record.response_text),
    decisionNote:
      normalizeString(record.decisionNote) ||
      normalizeString(record.decision_note),
  };
}

export function parseChatDecisionResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return chatDecisionSchema.parse(
    normalizeRawChatDecision(JSON.parse(jsonText))
  );
}
