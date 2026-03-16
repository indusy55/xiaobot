import type { ZodType } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface ToolExecutionOptions {
  signal?: AbortSignal;
}

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  execute(input: TInput, options?: ToolExecutionOptions): Promise<TOutput>;
  asLangChainTool?(): StructuredToolInterface;
}
