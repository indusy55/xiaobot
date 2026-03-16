import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { extractMessageQuote } from "../bot/message-quote.js";
import type { ResearchObservationNote } from "../infra/ai/research-loop.js";
import { formatMessageSpeakerPrefix } from "../infra/ai/runtime-context.js";
import { resolveTelegramMessageImagePart } from "../infra/media/telegram-media.js";
import { type WebSearchContext } from "../infra/search/searxng.js";
import { formatWebSearchPrompt } from "../infra/tools/web-search.js";
import type { ChatTaskPayload, TaskContextMessage, TaskDependencies } from "./types.js";

export interface ChatLatestUserInputContext {
  normalizedInput: string | null;
  speaker: string | null;
  triggerMessageId: number | null;
  contentType: string | null;
}

export interface ChatToolObservationRecord {
  type: "web_search";
  context: WebSearchContext | null;
  source: "current_turn" | "snapshot";
}

function toModelMessageContent(message: {
  contentType: string;
  textContent: string | null;
}) {
  if (
    typeof message.textContent === "string" &&
    message.textContent.trim().length > 0
  ) {
    return message.textContent;
  }

  return `[${message.contentType}]`;
}

async function toUserMessageContent(
  dependencies: Pick<TaskDependencies, "api" | "telegramMediaCacheDir">,
  message: TaskContextMessage,
  signal: AbortSignal
) {
  const content = toModelMessageContent(message);
  const speakerPrefix = formatMessageSpeakerPrefix(message);
  const finalUserContent =
    speakerPrefix == null ? content : `${speakerPrefix}: ${content}`;
  const imagePart = await resolveTelegramMessageImagePart({
    api: dependencies.api,
    cacheDir: dependencies.telegramMediaCacheDir,
    rawMessage: message.rawMessage,
    contentType: message.contentType,
    signal,
  }).catch(() => null);
  const quote = extractMessageQuote(message.rawMessage);
  const quoteLine = quote == null ? null : `Quoted part: "${quote.text}"`;
  const textParts: { type: "text"; text: string }[] = [
    {
      type: "text",
      text: [
        finalUserContent,
        message.contentType === "sticker" && imagePart?.emoji
          ? `Sticker emoji: ${imagePart.emoji}`
          : null,
        quoteLine,
      ]
        .filter((value): value is string => value != null)
        .join("\n"),
    },
  ];

  return imagePart == null ? finalUserContent : [...textParts, imagePart];
}

function clipText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatSnapshotWebSearchContext(context: WebSearchContext) {
  const lines = ["Previous search context:", `- Query: ${context.query}`];

  if (context.answer) {
    lines.push(`- Quick answer: ${clipText(context.answer, 240)}`);
  }

  if (context.results.length > 0) {
    lines.push("- Top results:");
    lines.push(
      ...context.results.slice(0, 5).map((result, index) =>
        [`${index + 1}. ${result.title}`, result.link]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0
          )
          .join("\n")
      )
    );
  }

  return lines.join("\n");
}

function isWebSearchContext(value: unknown): value is WebSearchContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "string" &&
    "results" in value &&
    Array.isArray(value.results)
  );
}

export function applyChatUserInputOverride(
  contextMessages: TaskContextMessage[],
  triggerTelegramMessageId: number | null,
  userInput?: string
) {
  if (!userInput || triggerTelegramMessageId == null) {
    return contextMessages;
  }

  for (let index = contextMessages.length - 1; index >= 0; index -= 1) {
    const message = contextMessages[index];
    if (!message) {
      continue;
    }

    if (
      message.role === "user" &&
      message.telegramMessageId === triggerTelegramMessageId
    ) {
      return contextMessages.map((item, itemIndex) =>
        itemIndex === index ? { ...item, textContent: userInput } : item
      );
    }
  }

  return contextMessages;
}

export function findChatTriggerMessage(
  contextMessages: TaskContextMessage[],
  triggerTelegramMessageId: number | null
) {
  if (triggerTelegramMessageId == null) {
    return contextMessages.at(-1) ?? null;
  }

  return (
    contextMessages.find(
      (message) => message.telegramMessageId === triggerTelegramMessageId
    ) ?? null
  );
}

export function buildLatestUserInputContext(options: {
  payload: ChatTaskPayload;
  triggerMessage: TaskContextMessage | null;
}): ChatLatestUserInputContext {
  const normalizedInput = (
    options.payload.userInput ??
    options.payload.text ??
    options.triggerMessage?.textContent ??
    ""
  ).trim();

  return {
    normalizedInput: normalizedInput.length > 0 ? normalizedInput : null,
    speaker:
      options.triggerMessage?.role === "user"
        ? formatMessageSpeakerPrefix(options.triggerMessage)
        : null,
    triggerMessageId: options.triggerMessage?.telegramMessageId ?? null,
    contentType: options.triggerMessage?.contentType ?? null,
  };
}

export async function buildChatModelMessages(options: {
  dependencies: Pick<TaskDependencies, "api" | "telegramMediaCacheDir">;
  contextMessages: TaskContextMessage[];
  signal: AbortSignal;
}): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [];

  for (const message of options.contextMessages) {
    const content = toModelMessageContent(message);

    switch (message.role) {
      case "assistant":
        messages.push(new AIMessage(content));
        break;
      case "system":
        messages.push(new SystemMessage(content));
        break;
      case "tool":
        messages.push(new SystemMessage(`Tool output: ${content}`));
        break;
      case "user":
      default: {
        const userContent = await toUserMessageContent(
          options.dependencies,
          message,
          options.signal
        );
        messages.push(new HumanMessage(userContent));
        break;
      }
    }
  }

  return messages;
}

export function extractToolObservationsFromSnapshot(snapshot: string | null) {
  if (!snapshot) {
    return [] as ChatToolObservationRecord[];
  }

  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    const observations: ChatToolObservationRecord[] = [];
    const rawObservations = Array.isArray(parsed.toolObservations)
      ? parsed.toolObservations
      : [];

    for (const rawObservation of rawObservations) {
      if (typeof rawObservation !== "object" || rawObservation === null) {
        continue;
      }

      const record = rawObservation as Record<string, unknown>;
      if (record.type === "web_search" && isWebSearchContext(record.context)) {
        observations.push({
          type: "web_search",
          context: record.context,
          source: "snapshot",
        });
      }
    }

    if (observations.length > 0) {
      return observations;
    }

    if (isWebSearchContext(parsed.webSearchContext)) {
      observations.push({
        type: "web_search",
        context: parsed.webSearchContext,
        source: "snapshot",
      });
    }

    return observations;
  } catch {
    return [] as ChatToolObservationRecord[];
  }
}

export function buildResearchObservationNotes(
  observations: ChatToolObservationRecord[]
) {
  return observations.map<ResearchObservationNote>((observation) => ({
    summary:
      observation.source === "snapshot"
        ? formatSnapshotWebSearchContext(
            observation.context as WebSearchContext
          )
        : formatWebSearchPrompt(observation.context as WebSearchContext),
  }));
}

export function buildToolContextPrompt(
  observations: ChatToolObservationRecord[]
) {
  const notes = buildResearchObservationNotes(observations)
    .map((item) => item.summary.trim())
    .filter((item) => item.length > 0);

  if (notes.length === 0) {
    return null;
  }

  return notes.join("\n\n");
}

export function buildResponsePlanPrompt(options: {
  responseBrief: string;
  responseMode: "text" | "text_with_sticker" | "sticker_only";
  replyMode: "reply_to_message" | "send_message" | "silent";
  replyToMessageId: number | null;
  targetUserId: string | null;
}) {
  const lines = [
    "Response plan:",
    "- Action: respond",
    `- Delivery mode: ${options.responseMode}`,
    `- Reply mode: ${options.replyMode}`,
  ];

  if (options.replyToMessageId != null) {
    lines.push(`- Reply target message id: ${options.replyToMessageId}`);
  }

  if (options.targetUserId != null) {
    lines.push(`- Primary target user id: ${options.targetUserId}`);
  }

  if (options.responseBrief.trim().length > 0) {
    lines.push(`- Goal: ${options.responseBrief.trim()}`);
  }

  if (options.responseMode === "sticker_only") {
    lines.push("- A real Telegram sticker will be sent by the runtime.");
    lines.push("- Do not say that you cannot send stickers.");
    lines.push("- Do not write placeholder text such as [sticker].");
    lines.push("- If no text is needed, return an empty string.");
  } else {
    lines.push("- Write the final user-facing text message only.");
    lines.push("- If sticker delivery is planned elsewhere, do not deny that capability.");
    lines.push("- Do not output placeholders such as [sticker], [image], or [photo].");
  }
  return lines.join("\n");
}
