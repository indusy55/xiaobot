import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import {
  telegramActionPlanSchema,
  type TelegramActionPlan,
  type TelegramContextPacket,
} from "../infra/ai/telegram-action-schema.js";
import { logError } from "../infra/error/index.js";
import type { TaskRecord } from "./types.js";

const CHAT_ACTION_PLAN_SYSTEM_PROMPT = [
  "Plan the Telegram bot's next response as a TelegramActionPlan JSON object.",
  "The bot only operates on Telegram.",
  "Use the provided context packet and only reference refs that exist in packet.refs.",
  "Prefer the smallest action plan that fully satisfies the latest request.",
  "If the bot should not reply, set disposition to ignore and return no operations.",
  "If replying with text, put the exact final user-facing text into send_message.text.",
  "If sending a real sticker, emit a send_sticker operation. Do not replace it with placeholder text.",
  "Use Telegram-native actions, not abstract prose about what the bot should do.",
  "Do not invent refs, message ids, or sticker ids.",
  "Return exactly one JSON object matching the TelegramActionPlan schema.",
].join("\n");

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
    throw new Error("Action plan response did not contain a JSON object");
  }

  return text.slice(start, end + 1);
}

function normalizeNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeOperationMode(value: unknown) {
  if (typeof value !== "string") {
    return "continue" as const;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "new") {
    return "new" as const;
  }

  if (
    normalized === "fork" ||
    normalized === "fork_from_message" ||
    normalized === "branch"
  ) {
    return "fork_from_message" as const;
  }

  return "continue" as const;
}

function normalizeOperationType(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "send_message":
    case "message":
    case "reply":
      return "send_message" as const;
    case "send_sticker":
    case "sticker":
      return "send_sticker" as const;
    case "enqueue_task":
    case "enqueue":
      return "enqueue_task" as const;
    case "cancel_task":
    case "cancel":
      return "cancel_task" as const;
    default:
      return null;
  }
}

function normalizeOperations(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<Record<string, unknown>[]>((acc, item, index) => {
    if (typeof item !== "object" || item == null) {
      return acc;
    }

    const record = item as Record<string, unknown>;
    const type = normalizeOperationType(record.type);
    if (type == null) {
      return acc;
    }

    switch (type) {
      case "send_message":
        acc.push({
          opId:
            typeof record.opId === "string" ? record.opId : `op_message_${index + 1}`,
          type,
          replyToRef:
            normalizeNullableString(record.replyToRef) ??
            normalizeNullableString(record.reply_to_ref),
          quoteRef:
            normalizeNullableString(record.quoteRef) ??
            normalizeNullableString(record.quote_ref),
          text: typeof record.text === "string" ? record.text : "",
          parseMode:
            record.parseMode === "None" || record.parse_mode === "None"
              ? "None"
              : "MarkdownV2",
          disableWebPreview:
            typeof record.disableWebPreview === "boolean"
              ? record.disableWebPreview
              : typeof record.disable_web_preview === "boolean"
                ? record.disable_web_preview
                : false,
        });
        return acc;
      case "send_sticker":
        acc.push({
          opId:
            typeof record.opId === "string" ? record.opId : `op_sticker_${index + 1}`,
          type,
          replyToRef:
            normalizeNullableString(record.replyToRef) ??
            normalizeNullableString(record.reply_to_ref),
          stickerRef:
            normalizeNullableString(record.stickerRef) ??
            normalizeNullableString(record.sticker_ref),
        });
        return acc;
      case "enqueue_task":
        acc.push({
          opId:
            typeof record.opId === "string" ? record.opId : `op_enqueue_${index + 1}`,
          type,
          taskKind: "chat" as const,
          input:
            typeof record.input === "string"
              ? record.input
              : typeof record.userInput === "string"
                ? record.userInput
                : "",
          conversation: {
            mode: normalizeOperationMode(
              (record.conversation as Record<string, unknown> | undefined)?.mode ??
                record.conversationMode
            ),
            anchorRef:
              normalizeNullableString(
                (record.conversation as Record<string, unknown> | undefined)?.anchorRef
              ) ??
              normalizeNullableString(
                (record.conversation as Record<string, unknown> | undefined)?.anchor_ref
              ),
            branchRootRef:
              normalizeNullableString(
                (record.conversation as Record<string, unknown> | undefined)?.branchRootRef
              ) ??
              normalizeNullableString(
                (record.conversation as Record<string, unknown> | undefined)?.branch_root_ref
              ),
          },
        });
        return acc;
      case "cancel_task":
        acc.push({
          opId:
            typeof record.opId === "string" ? record.opId : `op_cancel_${index + 1}`,
          type,
          scope:
            record.scope === "latest_in_chat"
              ? "latest_in_chat"
              : "latest_in_conversation",
        });
        return acc;
    }
  }, []);
}

function normalizeRawActionPlan(value: unknown) {
  if (typeof value !== "object" || value == null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return {
    disposition:
      record.disposition === "ignore" || record.action === "ignore"
        ? "ignore"
        : "respond",
    conversation: {
      mode: normalizeOperationMode(
        (record.conversation as Record<string, unknown> | undefined)?.mode
      ),
      anchorRef:
        normalizeNullableString(
          (record.conversation as Record<string, unknown> | undefined)?.anchorRef
        ) ??
        normalizeNullableString(
          (record.conversation as Record<string, unknown> | undefined)?.anchor_ref
        ),
      branchRootRef:
        normalizeNullableString(
          (record.conversation as Record<string, unknown> | undefined)?.branchRootRef
        ) ??
        normalizeNullableString(
          (record.conversation as Record<string, unknown> | undefined)?.branch_root_ref
        ),
    },
    operations: normalizeOperations(record.operations),
    usedRefs: Array.isArray(record.usedRefs)
      ? record.usedRefs.filter((value): value is string => typeof value === "string")
      : Array.isArray(record.used_refs)
        ? record.used_refs.filter((value): value is string => typeof value === "string")
        : [],
    notes: {
      summary:
        typeof (record.notes as Record<string, unknown> | undefined)?.summary === "string"
          ? ((record.notes as Record<string, unknown>).summary as string)
          : "",
      reasoningBrief:
        typeof (record.notes as Record<string, unknown> | undefined)?.reasoningBrief ===
        "string"
          ? ((record.notes as Record<string, unknown>).reasoningBrief as string)
          : typeof (record.notes as Record<string, unknown> | undefined)?.reasoning_brief ===
              "string"
            ? ((record.notes as Record<string, unknown>).reasoning_brief as string)
            : "",
    },
  };
}

export function buildTelegramActionPlanMessages(options: {
  systemPrompt: string;
  runtimeContextPrompt: string;
  inputEnvelopePrompt: string;
  packet: TelegramContextPacket;
}) {
  return [
    new SystemMessage(CHAT_ACTION_PLAN_SYSTEM_PROMPT),
    new SystemMessage(options.systemPrompt),
    new SystemMessage(options.runtimeContextPrompt),
    new SystemMessage(options.inputEnvelopePrompt),
    new HumanMessage(
      `Plan the next Telegram response.\nContext Packet JSON:\n${JSON.stringify(
        options.packet,
        null,
        2
      )}`
    ),
  ] satisfies BaseMessage[];
}

export function parseTelegramActionPlanResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return telegramActionPlanSchema.parse(
    normalizeRawActionPlan(JSON.parse(jsonText))
  );
}

export async function planChatNextStep(options: {
  record: Pick<TaskRecord, "id" | "chatId" | "conversationId">;
  decisionModel: ChatOpenAI;
  decisionTimeoutMs: number;
  signal: AbortSignal;
  systemPrompt: string;
  runtimeContextPrompt: string;
  inputEnvelopePrompt: string;
  packet: TelegramContextPacket;
}) {
  const {
    record,
    decisionModel,
    decisionTimeoutMs,
    signal,
    systemPrompt,
    runtimeContextPrompt,
    inputEnvelopePrompt,
    packet,
  } = options;

  try {
    const messages = buildTelegramActionPlanMessages({
      systemPrompt,
      runtimeContextPrompt,
      inputEnvelopePrompt,
      packet,
    });
    const planSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(decisionTimeoutMs),
    ]);
    const response = await decisionModel.invoke(messages, {
      signal: planSignal,
    });

    return parseTelegramActionPlanResponse(response);
  } catch (error) {
    logError("CHAT_ACTION_PLAN", error, {
      taskId: record.id,
      conversationId: record.conversationId,
      chatId: record.chatId,
    });
    return null;
  }
}
