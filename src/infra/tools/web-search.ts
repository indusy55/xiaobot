import { z } from "zod";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import {
  formatWebSearchPrompt,
  normalizeSearchQuery,
  searchWeb,
  type WebSearchContext,
} from "../search/searxng.js";
import type { ToolDefinition, ToolExecutionOptions } from "./types.js";

const webSearchToolInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
});

export type WebSearchToolInput = z.infer<typeof webSearchToolInputSchema>;

function ensureToolSignalIsActive(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Web search was aborted");
  }
}

async function runWebSearch(
  input: WebSearchToolInput,
  options?: ToolExecutionOptions
) {
  ensureToolSignalIsActive(options?.signal);
  const parsed = webSearchToolInputSchema.parse(input);
  const result = await searchWeb(parsed.query, options);
  ensureToolSignalIsActive(options?.signal);
  return result;
}

export const langChainWebSearchTool = tool(
  async (input: WebSearchToolInput) => runWebSearch(input),
  {
    name: "web_search",
    description:
      "Search the web for fresh public information such as news, current events, documentation, weather, and prices.",
    schema: webSearchToolInputSchema,
  }
);

export const webSearchTool: ToolDefinition<
  WebSearchToolInput,
  WebSearchContext | null
> = {
  name: "web_search",
  description:
    "Search the web for fresh public information such as news, current events, documentation, weather, and prices.",
  inputSchema: webSearchToolInputSchema,
  async execute(input: WebSearchToolInput, options?: ToolExecutionOptions) {
    return runWebSearch(input, options);
  },
  asLangChainTool() {
    return langChainWebSearchTool;
  },
};

export const openAIWebSearchTool = convertToOpenAITool(langChainWebSearchTool);

export function maybeBuildWebSearchInput(text: string): WebSearchToolInput | null {
  const query = normalizeSearchQuery(text);
  if (!query) {
    return null;
  }

  return { query };
}

export async function maybeRunWebSearchTool(
  text: string,
  options?: ToolExecutionOptions
) {
  const input = maybeBuildWebSearchInput(text);
  if (!input) {
    return null;
  }

  return webSearchTool.execute(input, options);
}

export async function runWebSearchTool(
  query: string,
  options?: ToolExecutionOptions
) {
  return webSearchTool.execute({ query }, options);
}

export function getLangChainWebSearchTool(): StructuredToolInterface {
  return langChainWebSearchTool;
}

export { formatWebSearchPrompt };
