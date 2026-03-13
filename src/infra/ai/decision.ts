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

export const chatDecisionSchema = z.object({
  version: z.literal(1),
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

interface BuildDecisionMessagesOptions {
  decisionPrompt: string;
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
  recentChatMessages: TaskContextMessage[];
}

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
    decisionPrompt,
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
    candidate_reply_message_ids: getCandidateReplyMessageIds(recentChatMessages),
    trigger_message: triggerMessage ? serializeMessage(triggerMessage) : null,
    replied_message: repliedMessage ? serializeMessage(repliedMessage) : null,
    participants: buildParticipants(recentChatMessages),
    current_conversation_messages: conversationMessages.map(serializeMessage),
    recent_chat_messages: recentChatMessages.slice(-12).map(serializeMessage),
  };

  return [
    new SystemMessage(decisionPrompt),
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

export function sanitizeChatDecision(
  decision: ChatDecision,
  options: SanitizeDecisionOptions
) {
  const allowedReplyMessageIds = new Set(
    getCandidateReplyMessageIds(options.recentChatMessages)
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

export function buildFallbackChatDecision(triggerTelegramMessageId: number | null): ChatDecision {
  return {
    version: 1,
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
  responseBrief?: string;
}) {
  return {
    version: 1 as const,
    action: "respond" as const,
    replyMode:
      options.triggerTelegramMessageId == null ? "send_message" as const : "reply_to_message" as const,
    replyToMessageId: options.triggerTelegramMessageId,
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
