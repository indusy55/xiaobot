type TelegramEntity = Record<string, unknown>;

interface TelegramMessageEntity {
  type?: unknown;
  offset?: unknown;
  length?: unknown;
  url?: unknown;
}

function asEntity(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as TelegramEntity)
    : undefined;
}

function getStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function getNumberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function unwrapStoredMessage(rawMessage: string) {
  try {
    const parsed = JSON.parse(rawMessage);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const parsedEntity = parsed as TelegramEntity;
    return asEntity(parsedEntity.message) ?? parsedEntity;
  } catch {
    return null;
  }
}

function getMessageText(message: TelegramEntity) {
  return (
    getStringValue(message.text) ??
    getStringValue(message.caption) ??
    ""
  );
}

function getMessageEntities(message: TelegramEntity) {
  const entities = message.entities;
  if (Array.isArray(entities)) {
    return entities as TelegramMessageEntity[];
  }

  const captionEntities = message.caption_entities;
  if (Array.isArray(captionEntities)) {
    return captionEntities as TelegramMessageEntity[];
  }

  return [];
}

function normalizeUrl(url: string) {
  return url.trim().replace(/[),.!?]+$/g, "");
}

export function extractUrlsFromRawMessage(rawMessage: string | null | undefined) {
  if (!rawMessage) {
    return [];
  }

  const message = unwrapStoredMessage(rawMessage);
  if (!message) {
    return [];
  }

  const text = getMessageText(message);
  const urls = new Set<string>();

  for (const entity of getMessageEntities(message)) {
    const type = getStringValue(entity.type);
    if (type === "text_link") {
      const url = getStringValue(entity.url);
      if (url) {
        urls.add(normalizeUrl(url));
      }
      continue;
    }

    if (type !== "url") {
      continue;
    }

    const offset = getNumberValue(entity.offset);
    const length = getNumberValue(entity.length);
    if (offset == null || length == null || length <= 0) {
      continue;
    }

    const extracted = text.slice(offset, offset + length).trim();
    if (extracted.length > 0) {
      urls.add(normalizeUrl(extracted));
    }
  }

  return [...urls].filter((url) => url.length > 0);
}
