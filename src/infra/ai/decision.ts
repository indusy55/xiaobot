import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type { TaskContextMessage } from "../../tasks/types.js";

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

export const capabilityDecisionSchema = z.object({
  shouldSearch: z.boolean(),
  query: z.string().max(256).nullable(),
  shouldReadWebpage: z.boolean(),
  webpageReadMode: z.enum(["none", "direct_url", "search_result"]),
  directUrl: z.string().url().max(2048).nullable(),
  reason: z.string().max(200),
});

export const webpageReadDecisionSchema = z.object({
  shouldRead: z.boolean(),
  url: z.string().url().max(2048).nullable(),
  reason: z.string().max(200),
});

export const chatDecisionSchema = z.object({
  action: z.enum(["respond", "ignore"]),
  replyMode: z.enum(["reply_to_message", "send_message", "silent"]),
  replyToMessageId: z.number().int().positive().nullable(),
  targetUserId: z.string().nullable(),
  conversation: conversationModeSchema,
  taskActions: z
    .array(z.discriminatedUnion("type", [cancelTaskActionSchema, enqueueTaskActionSchema]))
    .max(3),
  responseBrief: z.string().max(500),
  decisionNote: z.string().max(300),
});

export type ChatDecision = z.infer<typeof chatDecisionSchema>;
export type ChatTaskAction = ChatDecision["taskActions"][number];
export type WebSearchDecision = z.infer<typeof webSearchDecisionSchema>;
export type CapabilityDecision = z.infer<typeof capabilityDecisionSchema>;
export type WebpageReadDecision = z.infer<typeof webpageReadDecisionSchema>;

export interface WebpageCandidateUrl {
  url: string;
  source:
    | "trigger_message"
    | "replied_message"
    | "conversation_message"
    | "search_result";
  title?: string | null;
  snippet?: string | null;
}

interface BuildDecisionMessagesOptions {
  runtimeContextPrompt: string;
  conversationId: string;
  conversationMessages: TaskContextMessage[];
  recentChatMessages: TaskContextMessage[];
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
}

interface SanitizeDecisionOptions {
  allowTaskActions: boolean;
  triggerTelegramMessageId: number | null;
  triggerUserId: string | null;
  repliedTelegramMessageId: number | null;
  conversationMessages: TaskContextMessage[];
  recentChatMessages: TaskContextMessage[];
}

interface SanitizeWebSearchDecisionOptions {
  fallbackQuery: string | null;
}

interface SanitizeCapabilityDecisionOptions {
  fallbackQuery: string | null;
  directCandidateUrls: string[];
}

interface SanitizeWebpageReadDecisionOptions {
  candidateUrls: string[];
}

const CHAT_DECISION_SYSTEM_PROMPT = [
  "Decide how the Telegram bot should react to the latest message.",
  "Base the decision on the latest request and the provided chat context.",
  "Be conservative in group chats and practical in private chats.",
  "Do not invent message ids or user ids.",
  "Return exactly one JSON object with these fields:",
  "- action",
  "- replyMode",
  "- replyToMessageId",
  "- targetUserId",
  "- conversation",
  "- taskActions",
  "- responseBrief",
  "- decisionNote",
].join("\n");

const CAPABILITY_DECISION_SYSTEM_PROMPT = [
  "Decide which external capabilities should be used before the final reply.",
  "Use capabilities only when they materially improve the answer.",
  "Use search for web lookup or fresh public information.",
  "Use webpage reading only when actual page contents are needed.",
  "If a direct URL is already available and should be inspected, prefer direct_url.",
  "Return exactly one JSON object with these fields:",
  "- shouldSearch",
  "- query",
  "- shouldReadWebpage",
  "- webpageReadMode",
  "- directUrl",
  "- reason",
].join("\n");

const WEB_SEARCH_DECISION_SYSTEM_PROMPT = [
  "Decide whether web search is needed before the final reply.",
  "Use search only when it materially improves the answer.",
  "Return exactly one JSON object with these fields:",
  "- shouldSearch",
  "- query",
  "- reason",
].join("\n");

const WEBPAGE_READ_DECISION_SYSTEM_PROMPT = [
  "Decide whether a webpage should be read before the final reply.",
  "Read a webpage only when its actual contents are needed.",
  "Return exactly one JSON object with these fields:",
  "- shouldRead",
  "- url",
  "- reason",
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
    conversationId,
    conversationMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
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
    participants: buildParticipants(recentChatMessages),
    current_conversation_messages: conversationMessages.map(serializeMessage),
    recent_chat_messages: recentChatMessages.slice(-12).map(serializeMessage),
  };

  return [
    new SystemMessage(CHAT_DECISION_SYSTEM_PROMPT),
    new SystemMessage(runtimeContextPrompt),
    new HumanMessage(
      `Decide the next Telegram bot action for the latest message.\nContext JSON:\n${JSON.stringify(
        payload,
        null,
        2
      )}`
    ),
  ];
}

export function buildWebSearchDecisionMessages(options: BuildDecisionMessagesOptions) {
  const {
    runtimeContextPrompt,
    conversationId,
    conversationMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
  } = options;
  const payload = {
    conversation_id: conversationId,
    trigger_message: triggerMessage ? serializeMessage(triggerMessage) : null,
    replied_message: repliedMessage ? serializeMessage(repliedMessage) : null,
    current_conversation_messages: conversationMessages
      .slice(-10)
      .map(serializeMessage),
    recent_chat_messages: recentChatMessages.slice(-8).map(serializeMessage),
  };

  return [
    new SystemMessage(WEB_SEARCH_DECISION_SYSTEM_PROMPT),
    new SystemMessage(runtimeContextPrompt),
    new HumanMessage(
      `Decide whether web search is needed before answering the latest message.\nContext JSON:\n${JSON.stringify(
        payload,
        null,
        2
      )}`
    ),
  ];
}

export function buildCapabilityDecisionMessages(
  options: BuildDecisionMessagesOptions & {
    directCandidateUrls: WebpageCandidateUrl[];
  }
) {
  const {
    runtimeContextPrompt,
    conversationId,
    conversationMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
    directCandidateUrls,
  } = options;
  const payload = {
    conversation_id: conversationId,
    trigger_message: triggerMessage ? serializeMessage(triggerMessage) : null,
    replied_message: repliedMessage ? serializeMessage(repliedMessage) : null,
    current_conversation_messages: conversationMessages
      .slice(-10)
      .map(serializeMessage),
    recent_chat_messages: recentChatMessages.slice(-8).map(serializeMessage),
    direct_candidate_urls: directCandidateUrls,
  };

  return [
    new SystemMessage(CAPABILITY_DECISION_SYSTEM_PROMPT),
    new SystemMessage(runtimeContextPrompt),
    new HumanMessage(
      `Decide which external capabilities are needed before answering the latest message.\nContext JSON:\n${JSON.stringify(
        payload,
        null,
        2
      )}`
    ),
  ];
}

export function buildWebpageReadDecisionMessages(
  options: BuildDecisionMessagesOptions & {
    candidateUrls: WebpageCandidateUrl[];
  }
) {
  const {
    runtimeContextPrompt,
    conversationId,
    conversationMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
    candidateUrls,
  } = options;
  const payload = {
    conversation_id: conversationId,
    trigger_message: triggerMessage ? serializeMessage(triggerMessage) : null,
    replied_message: repliedMessage ? serializeMessage(repliedMessage) : null,
    current_conversation_messages: conversationMessages
      .slice(-10)
      .map(serializeMessage),
    recent_chat_messages: recentChatMessages.slice(-8).map(serializeMessage),
    candidate_urls: candidateUrls,
  };

  return [
    new SystemMessage(WEBPAGE_READ_DECISION_SYSTEM_PROMPT),
    new SystemMessage(runtimeContextPrompt),
    new HumanMessage(
      `Decide whether a webpage should be read before answering the latest message.\nContext JSON:\n${JSON.stringify(
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
      replyMode: "silent" as const,
      replyToMessageId: null,
      targetUserId,
      conversation,
      taskActions,
      responseBrief,
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
    replyMode,
    replyToMessageId,
    targetUserId,
    conversation,
    taskActions,
    responseBrief,
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

export function sanitizeCapabilityDecision(
  decision: CapabilityDecision,
  options: SanitizeCapabilityDecisionOptions
) {
  const directCandidateUrlSet = new Set(options.directCandidateUrls);
  const query = cleanValue(decision.query) ?? options.fallbackQuery;
  const directUrl = cleanValue(decision.directUrl);

  const shouldSearch = decision.shouldSearch && query != null;
  const sanitizedQuery = shouldSearch ? query.slice(0, 256) : null;

  if (!decision.shouldReadWebpage || decision.webpageReadMode === "none") {
    return {
      ...decision,
      shouldSearch,
      query: sanitizedQuery,
      shouldReadWebpage: false,
      webpageReadMode: "none" as const,
      directUrl: null,
    };
  }

  if (decision.webpageReadMode === "direct_url") {
    if (directUrl == null || !directCandidateUrlSet.has(directUrl)) {
      return {
        ...decision,
        shouldSearch,
        query: sanitizedQuery,
        shouldReadWebpage: false,
        webpageReadMode: "none" as const,
        directUrl: null,
      };
    }

    return {
      ...decision,
      shouldSearch,
      query: sanitizedQuery,
      shouldReadWebpage: true,
      webpageReadMode: "direct_url" as const,
      directUrl,
    };
  }

  return {
    ...decision,
    shouldSearch,
    query: sanitizedQuery,
    shouldReadWebpage: shouldSearch,
    webpageReadMode: shouldSearch ? "search_result" as const : "none" as const,
    directUrl: null,
  };
}

export function sanitizeWebpageReadDecision(
  decision: WebpageReadDecision,
  options: SanitizeWebpageReadDecisionOptions
) {
  const allowedUrls = new Set(options.candidateUrls);
  const url = cleanValue(decision.url);

  if (!decision.shouldRead || url == null || !allowedUrls.has(url)) {
    return {
      ...decision,
      shouldRead: false,
      url: null,
    };
  }

  return {
    ...decision,
    shouldRead: true,
    url,
  };
}

export function buildFallbackChatDecision(triggerTelegramMessageId: number | null): ChatDecision {
  return {
    action: "respond",
    replyMode:
      triggerTelegramMessageId == null ? "send_message" : "reply_to_message",
    replyToMessageId: triggerTelegramMessageId,
    targetUserId: null,
    conversation: {
      mode: "continue",
      anchorMessageId: null,
    },
    taskActions: [],
    responseBrief: "",
    decisionNote: "Fallback decision",
  };
}

export function buildFastPathChatDecision(options: {
  triggerTelegramMessageId: number | null;
  triggerUserId: string | null;
  replyToMessageId?: number | null;
  responseBrief?: string;
}) {
  const replyToMessageId =
    options.replyToMessageId ?? options.triggerTelegramMessageId;

  return {
    action: "respond" as const,
    replyMode:
      replyToMessageId == null ? "send_message" as const : "reply_to_message" as const,
    replyToMessageId,
    targetUserId: options.triggerUserId,
    conversation: {
      mode: "continue" as const,
      anchorMessageId: null,
    },
    taskActions: [],
    responseBrief:
      options.responseBrief?.trim() || "Answer the latest user message helpfully.",
    decisionNote: "Fast path decision",
  };
}

export function buildFallbackWebSearchDecision(): WebSearchDecision {
  return {
    shouldSearch: false,
    query: null,
    reason: "Fallback decision",
  };
}

export function buildFallbackCapabilityDecision(options?: {
  directCandidateUrls?: string[];
}): CapabilityDecision {
  const directUrl =
    options?.directCandidateUrls?.find((value) => cleanValue(value) != null) ?? null;

  if (directUrl != null) {
    return {
      shouldSearch: false,
      query: null,
      shouldReadWebpage: true,
      webpageReadMode: "direct_url",
      directUrl,
      reason: "Fallback direct URL decision",
    };
  }

  return {
    shouldSearch: false,
    query: null,
    shouldReadWebpage: false,
    webpageReadMode: "none",
    directUrl: null,
    reason: "Fallback decision",
  };
}

export function buildFallbackWebpageReadDecision(): WebpageReadDecision {
  return {
    shouldRead: false,
    url: null,
    reason: "Fallback decision",
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

export function parseChatDecisionResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return chatDecisionSchema.parse(JSON.parse(jsonText));
}

export function parseWebSearchDecisionResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return webSearchDecisionSchema.parse(JSON.parse(jsonText));
}

export function parseCapabilityDecisionResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return capabilityDecisionSchema.parse(JSON.parse(jsonText));
}

export function parseWebpageReadDecisionResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return webpageReadDecisionSchema.parse(JSON.parse(jsonText));
}
