import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

export interface ResearchAvailableUrl {
  url: string;
  label?: string | null;
  source: string;
}

export interface ResearchObservationNote {
  summary: string;
}

export const researchDecisionSchema = z.object({
  action: z.enum(["done", "search"]),
  query: z.string().max(256).nullable().optional(),
  reason: z.string().max(200),
});

export type ResearchDecision = z.infer<typeof researchDecisionSchema>;

const RESEARCH_DECISION_SYSTEM_PROMPT = [
  "Decide the next research step before the final reply.",
  "Choose exactly one action: done or search.",
  "Use as few tool calls as possible, but do not stop early if search is needed to answer well.",
  "Use search when web lookup or fresh public information is needed.",
  "If the answer is already supported by the current observations, choose done.",
  "Return exactly one JSON object with these fields:",
  "- action",
  "- query",
  "- reason",
].join("\n");

function cleanValue(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    throw new Error("Research decision response did not contain a JSON object");
  }

  return text.slice(start, end + 1);
}

export function parseResearchDecisionResponse(message: AIMessage) {
  const text = extractTextContent(message.content).trim();
  const jsonText = findJsonObject(text);
  return researchDecisionSchema.parse(JSON.parse(jsonText));
}

export function sanitizeResearchDecision(
  decision: ResearchDecision,
  options: {
    fallbackQuery: string | null;
  }
) {
  if (decision.action === "search") {
    const query = cleanValue(decision.query) ?? cleanValue(options.fallbackQuery);

    if (query == null) {
      return {
        action: "done" as const,
        query: null,
        reason: decision.reason,
      };
    }

    return {
      action: "search" as const,
      query: query.slice(0, 256),
      reason: decision.reason,
    };
  }

  return {
    action: "done" as const,
    query: null,
    reason: decision.reason,
  };
}

export function buildResearchDecisionMessages(options: {
  runtimeContextPrompt: string;
  conversationId: string;
  latestRequest: string | null;
  observations: ResearchObservationNote[];
  availableUrls: ResearchAvailableUrl[];
}) {
  const payload = {
    conversation_id: options.conversationId,
    latest_request: options.latestRequest,
    current_observations: options.observations.map((item) => item.summary),
  };

  return [
    new SystemMessage(RESEARCH_DECISION_SYSTEM_PROMPT),
    new SystemMessage(options.runtimeContextPrompt),
    new HumanMessage(
      `Decide the next research step for the latest Telegram message.\nContext JSON:\n${JSON.stringify(
        payload,
        null,
        2
      )}`
    ),
  ] satisfies BaseMessage[];
}
