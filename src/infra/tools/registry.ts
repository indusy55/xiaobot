import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolDefinition } from "./types.js";
import { openAIWebSearchTool, webSearchTool } from "./web-search.js";

export const internalTools = [
  webSearchTool,
] as const satisfies readonly ToolDefinition<unknown, unknown>[];

export const langChainTools = internalTools
  .map((tool) => tool.asLangChainTool?.())
  .filter((tool): tool is StructuredToolInterface => tool != null);

export const openAITools = [openAIWebSearchTool] as const;

export function getInternalToolByName(name: string) {
  return internalTools.find((tool) => tool.name === name) ?? null;
}
