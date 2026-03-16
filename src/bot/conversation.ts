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

export function buildBranchConversationId(
  baseConversationId: string,
  anchorTelegramMessageId: number,
  branchRootTelegramMessageId: number
) {
  if (branchRootTelegramMessageId === anchorTelegramMessageId) {
    return buildAnchoredConversationId(baseConversationId, anchorTelegramMessageId);
  }

  return `${buildAnchoredConversationId(baseConversationId, anchorTelegramMessageId)}:branch:${branchRootTelegramMessageId}`;
}

export function getBaseConversationId(conversationId: string) {
  const anchorIndex = conversationId.indexOf(":anchor:");
  if (anchorIndex === -1) {
    return conversationId;
  }

  return conversationId.slice(0, anchorIndex);
}

export function getAnchorMessageId(conversationId: string) {
  const anchorMatch = conversationId.match(/:anchor:(\d+)(?::branch:\d+)?$/);
  if (!anchorMatch) {
    return null;
  }

  const anchorMessageId = Number(anchorMatch[1]);
  return Number.isInteger(anchorMessageId) ? anchorMessageId : null;
}

export function getBranchRootMessageId(conversationId: string) {
  const branchMatch = conversationId.match(/:branch:(\d+)$/);
  if (!branchMatch) {
    return null;
  }

  const branchMessageId = Number(branchMatch[1]);
  return Number.isInteger(branchMessageId) ? branchMessageId : null;
}

export function hasBranchRootConversationId(conversationId: string) {
  return getBranchRootMessageId(conversationId) != null;
}

export function getAnchorConversationId(conversationId: string) {
  const baseConversationId = getBaseConversationId(conversationId);
  const anchorMessageId = getAnchorMessageId(conversationId);

  return anchorMessageId == null
    ? null
    : buildAnchoredConversationId(baseConversationId, anchorMessageId);
}

export function listConversationFamilyIds(conversationId: string) {
  const anchorConversationId = getAnchorConversationId(conversationId);

  return [...new Set([anchorConversationId, conversationId].filter(Boolean))];
}
