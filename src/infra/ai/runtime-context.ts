import type { TaskContextMessage } from "../../tasks/types.js";

interface BuildRuntimeContextPromptOptions {
  conversationMessages: TaskContextMessage[];
  recentChatMessages: TaskContextMessage[];
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
}

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

  if (fullName.length > 0 && username) {
    return `${fullName} (@${username})`;
  }

  if (fullName.length > 0) {
    return fullName;
  }

  if (username) {
    return `@${username}`;
  }

  if (message.fromId) {
    return `user#${message.fromId}`;
  }

  return "unknown user";
}

function getChatLabel(message: TaskContextMessage | null) {
  if (!message) {
    return "unknown";
  }

  switch (message.chatType) {
    case "private":
      return "private chat";
    case "group":
      return "group chat";
    case "supergroup":
      return "supergroup";
    default:
      return message.chatType;
  }
}

function toExcerpt(message: Pick<TaskContextMessage, "contentType" | "textContent">) {
  const text = cleanValue(message.textContent);
  if (!text) {
    return `[${message.contentType}]`;
  }

  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function buildParticipantSnapshot(messages: TaskContextMessage[]) {
  const map = new Map<
    string,
    {
      sample: TaskContextMessage;
      messageCount: number;
      latestCreatedAt: number;
    }
  >();

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const key =
      cleanValue(message.fromId) ??
      cleanValue(message.fromUsername) ??
      `message:${message.id}`;
    const current = map.get(key);

    if (!current) {
      map.set(key, {
        sample: message,
        messageCount: 1,
        latestCreatedAt: message.createdAt,
      });
      continue;
    }

    current.messageCount += 1;
    if (message.createdAt > current.latestCreatedAt) {
      current.latestCreatedAt = message.createdAt;
      current.sample = message;
    }
  }

  return [...map.values()].sort((left, right) => {
    if (right.messageCount !== left.messageCount) {
      return right.messageCount - left.messageCount;
    }

    return right.latestCreatedAt - left.latestCreatedAt;
  });
}

function buildParticipantLines(messages: TaskContextMessage[], maxParticipants = 5) {
  return buildParticipantSnapshot(messages)
    .slice(0, maxParticipants)
    .map((entry) => {
      const pieces = [
        formatDisplayName(entry.sample),
        `recent_messages=${entry.messageCount}`,
      ];
      const languageCode = cleanValue(entry.sample.fromLanguageCode);
      if (languageCode) {
        pieces.push(`lang=${languageCode}`);
      }

      return `- ${pieces.join(", ")}`;
    });
}

function buildCurrentSpeakerLine(triggerMessage: TaskContextMessage | null) {
  if (!triggerMessage || triggerMessage.role !== "user") {
    return null;
  }

  const parts = [`Current user: ${formatDisplayName(triggerMessage)}`];
  const languageCode = cleanValue(triggerMessage.fromLanguageCode);
  if (languageCode) {
    parts.push(`language=${languageCode}`);
  }

  return `- ${parts.join(", ")}`;
}

function buildReplyContextLine(repliedMessage: TaskContextMessage | null) {
  if (!repliedMessage) {
    return null;
  }

  const target =
    repliedMessage.role === "assistant"
      ? "assistant"
      : formatDisplayName(repliedMessage);

  return `- Current message is replying to: ${target}; replied content: ${toExcerpt(
    repliedMessage
  )}`;
}

function buildRecentTopicLine(
  triggerMessage: TaskContextMessage | null,
  recentChatMessages: TaskContextMessage[]
) {
  if (!triggerMessage || triggerMessage.role !== "user") {
    return null;
  }

  const triggerKey =
    cleanValue(triggerMessage.fromId) ?? cleanValue(triggerMessage.fromUsername);
  if (!triggerKey) {
    return null;
  }

  const excerpts = recentChatMessages
    .filter((message) => {
      if (message.role !== "user" || message.telegramMessageId === triggerMessage.telegramMessageId) {
        return false;
      }

      const messageKey =
        cleanValue(message.fromId) ?? cleanValue(message.fromUsername);
      return messageKey === triggerKey && cleanValue(message.textContent) != null;
    })
    .map((message) => toExcerpt(message))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(-3);

  if (excerpts.length === 0) {
    return null;
  }

  return `- Recent topics from current user: ${excerpts
    .map((excerpt) => `"${excerpt}"`)
    .join("; ")}`;
}

function buildConversationSummaryLine(conversationMessages: TaskContextMessage[]) {
  const userCount = conversationMessages.filter((message) => message.role === "user").length;
  const assistantCount = conversationMessages.filter(
    (message) => message.role === "assistant"
  ).length;

  return `- Current AI conversation window: ${userCount} user messages, ${assistantCount} assistant messages`;
}

export function buildRuntimeContextPrompt(options: BuildRuntimeContextPromptOptions) {
  const {
    conversationMessages,
    recentChatMessages,
    triggerMessage,
    repliedMessage,
  } = options;
  const firstMessage =
    triggerMessage ?? conversationMessages[0] ?? recentChatMessages[0] ?? null;
  const participantLines = buildParticipantLines(recentChatMessages);
  const currentSpeakerLine = buildCurrentSpeakerLine(triggerMessage);
  const replyContextLine = buildReplyContextLine(repliedMessage);
  const recentTopicLine = buildRecentTopicLine(triggerMessage, recentChatMessages);
  const lines = [
    "Runtime chat context:",
    `- Chat type: ${getChatLabel(firstMessage)}`,
    buildConversationSummaryLine(conversationMessages),
  ];

  const chatTitle = cleanValue(firstMessage?.chatTitle);
  if (chatTitle) {
    lines.push(`- Chat title: ${chatTitle}`);
  }

  if (currentSpeakerLine) {
    lines.push(currentSpeakerLine);
  }

  if (replyContextLine) {
    lines.push(replyContextLine);
  }

  if (firstMessage?.chatType === "private") {
    if (participantLines[0]) {
      lines.push("- Private chat counterpart:");
      lines.push(participantLines[0]);
    }
  } else if (participantLines.length > 0) {
    lines.push("- Recently active members in this chat:");
    lines.push(...participantLines);
  }

  if (recentTopicLine) {
    lines.push(recentTopicLine);
  }

  lines.push(
    "- Use speaker identity, reply target, and chat type as factual context when interpreting the next user message."
  );

  return lines.join("\n");
}

export function formatMessageSpeakerPrefix(message: TaskContextMessage) {
  if (message.role !== "user") {
    return null;
  }

  return formatDisplayName(message);
}
