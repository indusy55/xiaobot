import { ChatOpenAI } from "@langchain/openai";
import type { Env } from "../../config/index.js";

function buildCommonClientOptions(config: Env) {
  return {
    apiKey: config.OPENAI_API_KEY,
    ...(config.OPENAI_BASE_URL
      ? {
          configuration: {
            baseURL: config.OPENAI_BASE_URL,
          },
        }
      : {}),
  };
}

export function createChatModel(config: Env) {
  return new ChatOpenAI({
    model: config.OPENAI_MODEL,
    temperature: config.OPENAI_TEMPERATURE,
    ...buildCommonClientOptions(config),
  });
}

export function createDecisionModel(config: Env) {
  return new ChatOpenAI({
    model: config.OPENAI_DECISION_MODEL ?? config.OPENAI_MODEL,
    temperature: 0,
    ...buildCommonClientOptions(config),
  });
}
