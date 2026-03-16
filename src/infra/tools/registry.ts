import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolDefinition } from "./types.js";
import {
  openAIReadWebpageTool,
  readWebpageTool,
} from "./read-webpage.js";
import { openAIWebSearchTool, webSearchTool } from "./web-search.js";

export const internalTools = [
  webSearchTool,
  readWebpageTool,
] as const satisfies readonly ToolDefinition<unknown, unknown>[];

export const langChainTools = internalTools
  .map((tool) => tool.asLangChainTool?.())
  .filter((tool): tool is StructuredToolInterface => tool != null);

export const openAITools = [openAIWebSearchTool, openAIReadWebpageTool] as const;

export function getInternalToolByName(name: string) {
  return internalTools.find((tool) => tool.name === name) ?? null;
}
