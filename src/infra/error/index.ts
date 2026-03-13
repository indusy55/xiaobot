import { GrammyError } from "grammy";
import { logger } from "../logger/index.js";

export interface NormalizedError {
  code: string;
  message: string;
}

function toErrorCode(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

function serializeUnknownError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    if (error instanceof GrammyError) {
      return {
        code: "GRAMMY_ERROR",
        message: error.description || error.message,
      };
    }

    return {
      code: toErrorCode(error.name || "Error"),
      message: error.message,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: typeof error === "string" ? error : "Unknown error",
  };
}

export function normalizeError(error: unknown): NormalizedError {
  return serializeUnknownError(error);
}

export function isGrammyMessageNotModifiedError(error: unknown) {
  return (
    error instanceof GrammyError &&
    typeof error.description === "string" &&
    error.description.toLowerCase().includes("message is not modified")
  );
}

export function formatErrorMessage(scope: string, error: unknown): string {
  const normalized = normalizeError(error);
  return `[${scope}] ${normalized.code}: ${normalized.message}`;
}

export function logError(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>
) {
  const normalized = normalizeError(error);

  logger.error(
    {
      scope,
      ...normalized,
      ...(context ? { context } : {}),
    },
    formatErrorMessage(scope, error)
  );
}
