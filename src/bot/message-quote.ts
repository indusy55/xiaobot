type TelegramEntity = Record<string, unknown>;

export interface MessageQuote {
  text: string;
  position?: number;
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

export function extractMessageQuote(rawMessage: string | null | undefined): MessageQuote | null {
  if (!rawMessage) {
    return null;
  }

  const message = unwrapStoredMessage(rawMessage);
  if (!message) {
    return null;
  }

  const quote = asEntity(message.quote);
  if (quote) {
    const text = getStringValue(quote.text)?.trim();
    if (text) {
      const position = getNumberValue(quote.position);
      return position == null ? { text } : { text, position };
    }
  }

  const replyParameters = asEntity(message.reply_parameters);
  const replyQuoteText = getStringValue(replyParameters?.quote)?.trim();
  if (replyQuoteText) {
    const position = getNumberValue(replyParameters?.quote_position);
    return position == null
      ? { text: replyQuoteText }
      : { text: replyQuoteText, position };
  }

  return null;
}

export function buildReplyQuoteParameters(options: {
  rawMessage: string | null | undefined;
  replyToMessageId: number | null | undefined;
}) {
  const { rawMessage, replyToMessageId } = options;
  if (replyToMessageId == null) {
    return null;
  }

  const quote = extractMessageQuote(rawMessage);
  if (!quote) {
    return {
      message_id: replyToMessageId,
    };
  }

  return {
    message_id: replyToMessageId,
    quote: quote.text,
    ...(quote.position == null ? {} : { quote_position: quote.position }),
  };
}
