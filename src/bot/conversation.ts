export function buildConversationId(
  chatId: string,
  chatType: string,
  threadId?: number
) {
  if (chatType === "private") {
    return `private:${chatId}`;
  }

  if (threadId) {
    return `chat:${chatId}:thread:${threadId}`;
  }

  return `chat:${chatId}`;
}

export function buildAnchoredConversationId(
  baseConversationId: string,
  anchorTelegramMessageId: number
) {
  return `${baseConversationId}:anchor:${anchorTelegramMessageId}`;
}

export function getBaseConversationId(conversationId: string) {
  const anchorIndex = conversationId.indexOf(":anchor:");
  if (anchorIndex === -1) {
    return conversationId;
  }

  return conversationId.slice(0, anchorIndex);
}

export function getAnchorMessageId(conversationId: string) {
  const anchorMatch = conversationId.match(/:anchor:(\d+)$/);
  if (!anchorMatch) {
    return null;
  }

  const anchorMessageId = Number(anchorMatch[1]);
  return Number.isInteger(anchorMessageId) ? anchorMessageId : null;
}
