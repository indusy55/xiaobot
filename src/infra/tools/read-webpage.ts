import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { z } from "zod";
import {
  formatWebpageReadPrompt,
  readWebpage,
  type WebpageReadResult,
} from "../webpage/read-webpage.js";
import type { ToolDefinition, ToolExecutionOptions } from "./types.js";

const readWebpageToolInputSchema = z.object({
  url: z.string().trim().url().max(2048),
});

export type ReadWebpageToolInput = z.infer<typeof readWebpageToolInputSchema>;

async function runReadWebpage(
  input: ReadWebpageToolInput,
  options?: ToolExecutionOptions
) {
  const parsed = readWebpageToolInputSchema.parse(input);
  return readWebpage(parsed.url, options);
}

export const langChainReadWebpageTool = tool(
  async (input: ReadWebpageToolInput) => runReadWebpage(input),
  {
    name: "read_webpage",
    description:
      "Open a webpage in a headless browser, wait for dynamic content to load, and extract the main readable page text.",
    schema: readWebpageToolInputSchema,
  }
);

export const readWebpageTool: ToolDefinition<
  ReadWebpageToolInput,
  WebpageReadResult
> = {
  name: "read_webpage",
  description:
    "Open a webpage in a headless browser, wait for dynamic content to load, and extract the main readable page text.",
  inputSchema: readWebpageToolInputSchema,
  async execute(input: ReadWebpageToolInput, options?: ToolExecutionOptions) {
    return runReadWebpage(input, options);
  },
  asLangChainTool() {
    return langChainReadWebpageTool;
  },
};

export const openAIReadWebpageTool = convertToOpenAITool(
  langChainReadWebpageTool
);

export async function runReadWebpageTool(
  url: string,
  options?: ToolExecutionOptions
) {
  return readWebpageTool.execute({ url }, options);
}

export function getLangChainReadWebpageTool(): StructuredToolInterface {
  return langChainReadWebpageTool;
}

export { formatWebpageReadPrompt };
