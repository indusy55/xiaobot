import type { TaskContextMessage } from "../../tasks/types.js";

function cleanValue(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDisplayName(message: Pick<
  TaskContextMessage,
  "fromFirstName" | "fromLastName" | "fromUsername" | "fromId"
>) {
  const firstName = cleanValue(message.fromFirstName);
  const lastName = cleanValue(message.fromLastName);
  const username = cleanValue(message.fromUsername);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  if (fullName && username) {
    return `${fullName} (@${username})`;
  }

  if (fullName) {
    return fullName;
  }

  if (username) {
    return `@${username}`;
  }

  return message.fromId ? `user#${message.fromId}` : "unknown user";
}

function toExcerpt(message: TaskContextMessage) {
  const text = cleanValue(message.textContent);
  if (!text) {
    return `[${message.contentType}]`;
  }

  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function formatMessageLine(message: TaskContextMessage) {
  switch (message.role) {
    case "assistant":
      return `- Assistant: ${toExcerpt(message)}`;
    case "system":
      return `- System: ${toExcerpt(message)}`;
    case "tool":
      return `- Tool: ${toExcerpt(message)}`;
    case "user":
    default:
      return `- ${formatDisplayName(message)}: ${toExcerpt(message)}`;
  }
}

export function buildConversationBacklogSummary(messages: TaskContextMessage[]) {
  if (messages.length === 0) {
    return null;
  }

  const userMessageCount = messages.filter((message) => message.role === "user").length;
  const assistantMessageCount = messages.filter(
    (message) => message.role === "assistant"
  ).length;

  return [
    "Earlier conversation summary:",
    `- Omitted earlier messages: ${messages.length}`,
    `- Earlier user messages: ${userMessageCount}`,
    `- Earlier assistant messages: ${assistantMessageCount}`,
    "- Selected older excerpts:",
    ...messages.map((message) => formatMessageLine(message)),
  ].join("\n");
}
