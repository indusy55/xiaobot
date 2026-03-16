import type { TaskContextMessage } from "./types.js";

function findIndexByTelegramMessageId(
  messages: TaskContextMessage[],
  telegramMessageId: number | null
) {
  if (telegramMessageId == null) {
    return -1;
  }

  return messages.findIndex(
    (message) => message.telegramMessageId === telegramMessageId
  );
}

function buildMessageIndex(messages: TaskContextMessage[]) {
  return new Map(messages.map((message) => [message.id, message]));
}

function buildChildrenIndex(messages: TaskContextMessage[]) {
  const children = new Map<number, TaskContextMessage[]>();

  for (const message of messages) {
    if (message.parentMessageId == null) {
      continue;
    }

    const list = children.get(message.parentMessageId) ?? [];
    list.push(message);
    children.set(message.parentMessageId, list);
  }

  for (const list of children.values()) {
    list.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }

      return left.id - right.id;
    });
  }

  return children;
}

function collectAncestorIds(
  messagesById: Map<number, TaskContextMessage>,
  triggerMessage: TaskContextMessage,
  stopTelegramMessageIds: Set<number>
) {
  const ancestorIds = new Set<number>();

  let current: TaskContextMessage | undefined = triggerMessage;
  while (current && !ancestorIds.has(current.id)) {
    ancestorIds.add(current.id);
    if (
      current.telegramMessageId != null &&
      stopTelegramMessageIds.has(current.telegramMessageId)
    ) {
      break;
    }
    current =
      current.parentMessageId == null
        ? undefined
        : messagesById.get(current.parentMessageId);
  }

  return ancestorIds;
}

function findMessageByTelegramMessageId(
  messages: TaskContextMessage[],
  telegramMessageId: number | null
) {
  const index = findIndexByTelegramMessageId(messages, telegramMessageId);
  return index >= 0 ? messages[index] ?? null : null;
}

function collectLatestDescendantPath(options: {
  childrenByParentId: Map<number, TaskContextMessage[]>;
  startMessage: TaskContextMessage;
  beforeCreatedAt: number;
}) {
  const { childrenByParentId, startMessage, beforeCreatedAt } = options;
  const descendantIds = new Set<number>();
  let current = startMessage;

  while (true) {
    const nextChild =
      childrenByParentId
        .get(current.id)
        ?.filter((message) => message.createdAt < beforeCreatedAt)
        .at(-1) ?? null;

    if (!nextChild) {
      break;
    }

    descendantIds.add(nextChild.id);
    current = nextChild;
  }

  return descendantIds;
}

function trimContextWithPinnedMessages(
  messages: TaskContextMessage[],
  limit: number,
  pinnedIds: Set<number>
) {
  if (messages.length <= limit) {
    return messages;
  }

  const pinnedMessages = messages.filter((message) => pinnedIds.has(message.id));
  const pinnedMessageIds = new Set(pinnedMessages.map((message) => message.id));
  const remainingBudget = Math.max(limit - pinnedMessages.length, 0);
  const tailMessages = messages
    .filter((message) => !pinnedMessageIds.has(message.id))
    .slice(-remainingBudget);

  return [...pinnedMessages, ...tailMessages]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-limit);
}

export function assembleBranchAwareContext(options: {
  conversationMessages: TaskContextMessage[];
  triggerTelegramMessageId: number | null;
  limit: number;
  anchorMessageId?: number | null;
}) {
  const {
    conversationMessages,
    triggerTelegramMessageId,
    limit,
    anchorMessageId = null,
  } = options;

  if (conversationMessages.length === 0 || limit <= 0) {
    return [] as TaskContextMessage[];
  }

  const triggerIndex = findIndexByTelegramMessageId(
    conversationMessages,
    triggerTelegramMessageId
  );
  const triggerMessage =
    triggerIndex >= 0
      ? conversationMessages[triggerIndex]
      : conversationMessages.at(-1) ?? null;

  if (!triggerMessage) {
    return conversationMessages.slice(-limit);
  }

  const messagesById = buildMessageIndex(conversationMessages);
  const childrenByParentId = buildChildrenIndex(conversationMessages);
  const branchStartTelegramMessageId =
    triggerMessage.replyToTelegramMessageId ?? anchorMessageId;
  const branchStartMessage = findMessageByTelegramMessageId(
    conversationMessages,
    branchStartTelegramMessageId
  );
  const ancestorIds = collectAncestorIds(
    messagesById,
    triggerMessage,
    new Set(
      [branchStartTelegramMessageId, anchorMessageId].filter(
        (value): value is number => value != null
      )
    )
  );
  const selectedIds = new Set<number>(ancestorIds);

  if (branchStartMessage) {
    selectedIds.add(branchStartMessage.id);
  }

  if (
    triggerMessage.replyToTelegramMessageId != null &&
    branchStartMessage != null
  ) {
    const descendantIds = collectLatestDescendantPath({
      childrenByParentId,
      startMessage: branchStartMessage,
      beforeCreatedAt: triggerMessage.createdAt,
    });

    for (const descendantId of descendantIds) {
      selectedIds.add(descendantId);
    }
  }

  if (anchorMessageId != null) {
    const anchorIndex = findIndexByTelegramMessageId(
      conversationMessages,
      anchorMessageId
    );
    if (anchorIndex >= 0) {
      const anchorMessage = conversationMessages[anchorIndex];
      if (anchorMessage) {
        selectedIds.add(anchorMessage.id);
      }
    }
  }

  const selectedMessages = conversationMessages.filter((message) =>
    selectedIds.has(message.id)
  );
  const pinnedIds = new Set<number>([triggerMessage.id]);

  if (anchorMessageId != null) {
    const anchorIndex = findIndexByTelegramMessageId(
      conversationMessages,
      anchorMessageId
    );
    const anchorMessage =
      anchorIndex >= 0 ? conversationMessages[anchorIndex] : null;
    if (anchorMessage) {
      pinnedIds.add(anchorMessage.id);
    }
  }

  return trimContextWithPinnedMessages(selectedMessages, limit, pinnedIds);
}
