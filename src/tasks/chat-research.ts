import {
  buildResearchDecisionMessages,
  parseResearchDecisionResponse,
  sanitizeResearchDecision,
} from "../infra/ai/research-loop.js";
import { logError } from "../infra/error/index.js";
import { runWebSearchTool } from "../infra/tools/web-search.js";
import { buildResearchObservationNotes, type ChatToolObservationRecord } from "./chat-context.js";
import type { TaskDependencies, TaskRecord } from "./types.js";

export async function runChatResearchLoop(options: {
  record: Pick<TaskRecord, "id" | "chatId" | "conversationId">;
  decisionModel: TaskDependencies["decisionModel"];
  signal: AbortSignal;
  runtimeContextPrompt: string;
  fallbackQuery: string;
  priorToolObservations: ChatToolObservationRecord[];
}) {
  const {
    record,
    decisionModel,
    signal,
    runtimeContextPrompt,
    fallbackQuery,
    priorToolObservations,
  } = options;
  const observations: ChatToolObservationRecord[] = [];
  const seenToolCalls = new Set<string>();

  for (let step = 0; step < 4; step += 1) {
    try {
      const decisionMessages = buildResearchDecisionMessages({
        runtimeContextPrompt,
        conversationId: record.conversationId,
        latestRequest: fallbackQuery.trim() || null,
        observations: buildResearchObservationNotes([
          ...priorToolObservations,
          ...observations,
        ]),
        availableUrls: [],
      });
      const decisionSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(8000),
      ]);
      const decisionMessage = await decisionModel.invoke(decisionMessages, {
        signal: decisionSignal,
      });
      const rawDecision = parseResearchDecisionResponse(decisionMessage);
      const decision = sanitizeResearchDecision(rawDecision, {
        fallbackQuery: fallbackQuery.trim(),
      });

      if (decision.action === "done") {
        break;
      }

      if (decision.action === "search" && decision.query) {
        const toolKey = `search:${decision.query}`;
        if (seenToolCalls.has(toolKey)) {
          break;
        }

        seenToolCalls.add(toolKey);

        try {
          const context = await runWebSearchTool(decision.query, { signal });
          if (context != null) {
            observations.push({
              type: "web_search",
              context,
              source: "current_turn",
            });
          }
        } catch (error) {
          logError("WEB_SEARCH", error, {
            taskId: record.id,
            chatId: record.chatId,
            conversationId: record.conversationId,
            query: decision.query,
          });
        }

        continue;
      }

      break;
    } catch (error) {
      logError("CHAT_RESEARCH_DECISION", error, {
        taskId: record.id,
        conversationId: record.conversationId,
        chatId: record.chatId,
      });
      break;
    }
  }

  return observations;
}
