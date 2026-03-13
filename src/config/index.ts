import "dotenv/config";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (url) => {
        try {
          new URL(url);
          return true;
        } catch {
          return url.startsWith('file:') || url === ':memory:';
        }
      },
      { message: "DATABASE_URL must be a valid URL, file path, or :memory:" }
    ),
  ADMIN_ID: z
    .string()
    .min(1, "ADMIN_ID is required")
    .regex(/^\d+$/, "ADMIN_ID must be a positive number")
    .transform(Number),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().min(1, "OPENAI_MODEL is required"),
  OPENAI_DECISION_MODEL: z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }

      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().min(1, "OPENAI_DECISION_MODEL cannot be empty").optional()
  ),
  OPENAI_TEMPERATURE: z.preprocess(
    (value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
      }

      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    },
    z
      .number()
      .min(0, "OPENAI_TEMPERATURE must be at least 0")
      .max(2, "OPENAI_TEMPERATURE must be at most 2")
      .default(0.7)
  ),
  OPENAI_BASE_URL: z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }

      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().url("OPENAI_BASE_URL must be a valid URL").optional()
  ),
  TASK_TIMEOUT_MS: z.preprocess(
    (value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
      }

      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    },
    z
      .number()
      .int("TASK_TIMEOUT_MS must be an integer")
      .positive("TASK_TIMEOUT_MS must be greater than 0")
      .default(120_000)
  ),
});

export type Env = z.infer<typeof envSchema>;

let env: Env | null = null;

export function loadConfig(): Env {
  if (!env) {
    try {
      env = envSchema.parse(process.env);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map((issue) => issue.message).join("\n");
        throw new ConfigError(issues);
      }

      throw new ConfigError(
        error instanceof Error ? error.message : "Unknown configuration error"
      );
    }
  }
  return env;
}
