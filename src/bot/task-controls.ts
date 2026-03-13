import { InlineKeyboard } from "grammy";

export function buildTaskCancelKeyboard(taskId: number) {
  return new InlineKeyboard().text("Cancel", `task:cancel:${taskId}`);
}

export function buildTaskRetryKeyboard(taskId: number) {
  return new InlineKeyboard().text("Retry", `task:retry:${taskId}`);
}

export function parseTaskControlCallback(data: string) {
  const match = /^task:(cancel|retry):(\d+)$/.exec(data);
  if (!match) {
    return null;
  }

  const taskId = Number(match[2]);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return null;
  }

  return {
    action: match[1] as "cancel" | "retry",
    taskId,
  };
}
