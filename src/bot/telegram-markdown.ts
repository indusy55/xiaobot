import type { Api, RawApi } from "grammy";

type TelegramApi = Api<RawApi>;
type SendMessageOptions = NonNullable<
  Parameters<TelegramApi["sendMessage"]>[2]
>;
type EditMessageTextOptions = NonNullable<
  Parameters<TelegramApi["editMessageText"]>[3]
>;

const TELEGRAM_MARKDOWN_V2_LIMIT = 4000;
const MARKDOWN_V2_SPECIAL_CHARS = /([\\_*[\]()~`>#+\-=|{}.!])/g;

type MarkdownBlock =
  | {
      kind: "text";
      lines: string[];
    }
  | {
      kind: "code";
      language: string | null;
      lines: string[];
    };

export interface TelegramMarkdownChunk {
  rawText: string;
  formattedText: string;
}

function escapeMarkdownV2(text: string) {
  return text.replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$1");
}

function escapeMarkdownV2Code(text: string) {
  return text.replace(/([\\`])/g, "\\$1");
}

function escapeMarkdownV2Url(text: string) {
  return text.replace(/([\\)])/g, "\\$1");
}

function sanitizeCodeLanguage(language: string | null) {
  if (!language) {
    return "";
  }

  return /^[A-Za-z0-9_+\-#.]+$/.test(language) ? language : "";
}

function findClosingDelimiter(text: string, delimiter: string, fromIndex: number) {
  let index = fromIndex;

  while (index < text.length) {
    const foundIndex = text.indexOf(delimiter, index);
    if (foundIndex === -1) {
      return -1;
    }

    if (foundIndex > 0 && text[foundIndex - 1] === "\\") {
      index = foundIndex + delimiter.length;
      continue;
    }

    return foundIndex;
  }

  return -1;
}

function formatInlineMarkdown(text: string): string {
  let index = 0;
  let output = "";

  while (index < text.length) {
    const remaining = text.slice(index);

    if (remaining.startsWith("[")) {
      const closingBracket = findClosingDelimiter(text, "]", index + 1);
      const openParenIndex = closingBracket === -1 ? -1 : closingBracket + 1;
      const closingParen =
        openParenIndex >= text.length || text[openParenIndex] !== "("
          ? -1
          : findClosingDelimiter(text, ")", openParenIndex + 1);

      if (closingBracket !== -1 && closingParen !== -1) {
        const label = text.slice(index + 1, closingBracket);
        const url = text.slice(openParenIndex + 1, closingParen);
        output += `[${escapeMarkdownV2(label)}](${escapeMarkdownV2Url(url)})`;
        index = closingParen + 1;
        continue;
      }
    }

    if (remaining.startsWith("`")) {
      const backtickMatch = remaining.match(/^`+/);
      const delimiter = backtickMatch?.[0];
      if (delimiter) {
        const closingIndex = findClosingDelimiter(
          text,
          delimiter,
          index + delimiter.length
        );

        if (closingIndex !== -1) {
          const code = text.slice(index + delimiter.length, closingIndex);
          output += `\`${escapeMarkdownV2Code(code)}\``;
          index = closingIndex + delimiter.length;
          continue;
        }
      }
    }

    const pairedDelimiters = [
      { marker: "**", wrapper: "*" },
      { marker: "__", wrapper: "*" },
      { marker: "~~", wrapper: "~" },
      { marker: "||", wrapper: "||" },
      { marker: "*", wrapper: "_" },
      { marker: "_", wrapper: "_" },
    ] as const;

    let consumed = false;
    for (const delimiter of pairedDelimiters) {
      if (!remaining.startsWith(delimiter.marker)) {
        continue;
      }

      const closingIndex = findClosingDelimiter(
        text,
        delimiter.marker,
        index + delimiter.marker.length
      );

      if (closingIndex === -1) {
        continue;
      }

      const inner = text.slice(
        index + delimiter.marker.length,
        closingIndex
      );
      if (inner.trim().length === 0) {
        continue;
      }

      const formattedInner = formatInlineMarkdown(inner);
      output +=
        delimiter.wrapper === "||"
          ? `||${formattedInner}||`
          : `${delimiter.wrapper}${formattedInner}${delimiter.wrapper}`;
      index = closingIndex + delimiter.marker.length;
      consumed = true;
      break;
    }

    if (consumed) {
      continue;
    }

    output += escapeMarkdownV2(text[index] ?? "");
    index += 1;
  }

  return output;
}

function formatMarkdownLine(line: string) {
  if (line.trim().length === 0) {
    return "";
  }

  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch?.[2]) {
    return `*${formatInlineMarkdown(headingMatch[2].trim())}*`;
  }

  const quoteMatch = line.match(/^(>\s?)+(.*)$/);
  if (quoteMatch) {
    const prefix = quoteMatch[0].match(/^(>\s?)+/)?.[0] ?? "> ";
    const normalizedPrefix = prefix.replace(/\s*$/g, " ").replace(/\s+/g, " ");
    const content = quoteMatch[2]?.trim() ?? "";
    return `${normalizedPrefix}${formatInlineMarkdown(content)}`.trimEnd();
  }

  const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (bulletMatch?.[2]) {
    const indent = bulletMatch[1] ?? "";
    return `${indent}• ${formatInlineMarkdown(bulletMatch[2].trim())}`;
  }

  const taskListMatch = line.match(/^(\s*)[-*]\s+\[( |x|X)\]\s+(.+)$/);
  if (taskListMatch?.[3]) {
    const indent = taskListMatch[1] ?? "";
    const checked = taskListMatch[2]?.toLowerCase() === "x" ? "x" : " ";
    return `${indent}• \\[${checked}\\] ${formatInlineMarkdown(
      taskListMatch[3].trim()
    )}`;
  }

  const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (orderedMatch?.[2] && orderedMatch[3]) {
    const indent = orderedMatch[1] ?? "";
    return `${indent}${orderedMatch[2]}\\. ${formatInlineMarkdown(
      orderedMatch[3].trim()
    )}`;
  }

  const horizontalRuleMatch = line.match(/^([-*_]\s*){3,}$/);
  if (horizontalRuleMatch) {
    return "────────";
  }

  return formatInlineMarkdown(line);
}

function formatCodeBlock(language: string | null, lines: string[]) {
  const header = `\`\`\`${sanitizeCodeLanguage(language)}`;
  const body = lines.map((line) => escapeMarkdownV2Code(line)).join("\n");
  return `${header}\n${body}\n\`\`\``;
}

function parseMarkdownBlocks(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let textLines: string[] = [];
  let codeLines: string[] = [];
  let codeLanguage: string | null = null;
  let inCodeBlock = false;

  const flushTextBlock = () => {
    if (textLines.length === 0) {
      return;
    }

    blocks.push({
      kind: "text",
      lines: textLines,
    });
    textLines = [];
  };

  const flushCodeBlock = () => {
    blocks.push({
      kind: "code",
      language: codeLanguage,
      lines: codeLines,
    });
    codeLines = [];
    codeLanguage = null;
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w#+.-]+)?\s*$/);

    if (fenceMatch) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        flushTextBlock();
        inCodeBlock = true;
        codeLanguage = fenceMatch[1]?.trim() || null;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  if (inCodeBlock) {
    flushCodeBlock();
  } else {
    flushTextBlock();
  }

  return blocks;
}

function splitLongTextLine(line: string, limit: number) {
  const segments: string[] = [];
  const tokens = line.match(/\S+\s*/g) ?? [line];
  let current = "";

  for (const token of tokens) {
    const candidate = current + token;
    if (formatMarkdownLine(candidate).length <= limit) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      segments.push(current.trimEnd());
      current = "";
    }

    if (formatMarkdownLine(token).length <= limit) {
      current = token;
      continue;
    }

    let partial = "";
    for (const char of token) {
      const partialCandidate = partial + char;
      if (formatMarkdownLine(partialCandidate).length <= limit) {
        partial = partialCandidate;
        continue;
      }

      if (partial.length > 0) {
        segments.push(partial);
      }
      partial = char;
    }

    current = partial;
  }

  if (current.trim().length > 0) {
    segments.push(current.trimEnd());
  }

  return segments.length > 0 ? segments : [line];
}

function splitTextBlock(block: Extract<MarkdownBlock, { kind: "text" }>, limit: number) {
  const chunks: TelegramMarkdownChunk[] = [];
  let currentLines: string[] = [];

  const pushChunk = () => {
    if (currentLines.length === 0) {
      return;
    }

    const rawText = currentLines.join("\n").trimEnd();
    chunks.push({
      rawText,
      formattedText: rawText
        .split("\n")
        .map((line) => formatMarkdownLine(line))
        .join("\n"),
    });
    currentLines = [];
  };

  for (const originalLine of block.lines) {
    const lineVariants =
      formatMarkdownLine(originalLine).length <= limit
        ? [originalLine]
        : splitLongTextLine(originalLine, limit);

    for (const line of lineVariants) {
      const candidateLines = [...currentLines, line];
      const candidateFormatted = candidateLines
        .map((candidateLine) => formatMarkdownLine(candidateLine))
        .join("\n");

      if (candidateFormatted.length <= limit) {
        currentLines = candidateLines;
        continue;
      }

      pushChunk();
      currentLines = [line];
    }
  }

  pushChunk();
  return chunks;
}

function splitCodeLine(line: string, language: string | null, limit: number) {
  const chunks: string[] = [];
  let current = "";

  for (const char of line) {
    const candidate = current + char;
    if (formatCodeBlock(language, [candidate]).length <= limit) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    current = char;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [line];
}

function splitCodeBlock(block: Extract<MarkdownBlock, { kind: "code" }>, limit: number) {
  const chunks: TelegramMarkdownChunk[] = [];
  let currentLines: string[] = [];

  const pushChunk = () => {
    const rawText = [
      `\`\`\`${block.language ?? ""}`.trimEnd(),
      ...currentLines,
      "```",
    ].join("\n");

    chunks.push({
      rawText,
      formattedText: formatCodeBlock(block.language, currentLines),
    });
    currentLines = [];
  };

  for (const originalLine of block.lines) {
    const lineVariants =
      formatCodeBlock(block.language, [originalLine]).length <= limit
        ? [originalLine]
        : splitCodeLine(originalLine, block.language, limit);

    for (const line of lineVariants) {
      const candidateLines = [...currentLines, line];
      if (formatCodeBlock(block.language, candidateLines).length <= limit) {
        currentLines = candidateLines;
        continue;
      }

      if (currentLines.length > 0) {
        pushChunk();
      }

      currentLines = [line];
    }
  }

  if (currentLines.length > 0 || block.lines.length === 0) {
    pushChunk();
  }

  return chunks;
}

function normalizeChunkSpacing(chunks: TelegramMarkdownChunk[]) {
  return chunks.map((chunk) => ({
    rawText: chunk.rawText.trim(),
    formattedText: chunk.formattedText.trim(),
  }));
}

export function formatTelegramMarkdownV2(text: string) {
  const chunks = splitTelegramMarkdownV2(text);
  return chunks.map((chunk) => chunk.formattedText).join("\n\n");
}

export function splitTelegramMarkdownV2(
  text: string,
  limit = TELEGRAM_MARKDOWN_V2_LIMIT
) {
  const normalizedText = text.replace(/\r\n/g, "\n").trim();
  if (normalizedText.length === 0) {
    return [
      {
        rawText: "",
        formattedText: "",
      },
    ] satisfies TelegramMarkdownChunk[];
  }

  const blocks = parseMarkdownBlocks(normalizedText);
  const blockChunks = blocks.flatMap((block) =>
    block.kind === "code"
      ? splitCodeBlock(block, limit)
      : splitTextBlock(block, limit)
  );
  const chunks: TelegramMarkdownChunk[] = [];
  let currentRawText = "";
  let currentFormattedText = "";

  const pushChunk = () => {
    if (currentRawText.trim().length === 0 && currentFormattedText.trim().length === 0) {
      return;
    }

    chunks.push({
      rawText: currentRawText.trim(),
      formattedText: currentFormattedText.trim(),
    });
    currentRawText = "";
    currentFormattedText = "";
  };

  for (const blockChunk of blockChunks) {
    const nextRawText =
      currentRawText.length === 0
        ? blockChunk.rawText
        : `${currentRawText}\n\n${blockChunk.rawText}`;
    const nextFormattedText =
      currentFormattedText.length === 0
        ? blockChunk.formattedText
        : `${currentFormattedText}\n\n${blockChunk.formattedText}`;

    if (nextFormattedText.length <= limit) {
      currentRawText = nextRawText;
      currentFormattedText = nextFormattedText;
      continue;
    }

    pushChunk();
    currentRawText = blockChunk.rawText;
    currentFormattedText = blockChunk.formattedText;
  }

  pushChunk();

  return normalizeChunkSpacing(chunks);
}

export async function deliverMarkdownV2Text(options: {
  api: TelegramApi;
  chatId: number | string;
  placeholderMessageId: number;
  text: string;
  messageThreadId?: number;
  editOptions?: EditMessageTextOptions;
  sendOptions?: SendMessageOptions;
}) {
  const {
    api,
    chatId,
    placeholderMessageId,
    text,
    messageThreadId,
    editOptions,
    sendOptions,
  } = options;
  const chunks = splitTelegramMarkdownV2(text);
  const firstChunk = chunks[0] ?? {
    rawText: "",
    formattedText: "",
  };

  await api.editMessageText(
    chatId,
    placeholderMessageId,
    firstChunk.formattedText || " ",
    {
      ...editOptions,
      parse_mode: "MarkdownV2",
    }
  );

  const sentMessageIds: number[] = [placeholderMessageId];

  for (const chunk of chunks.slice(1)) {
    const message = await api.sendMessage(
      chatId,
      chunk.formattedText || " ",
      {
        ...sendOptions,
        ...(messageThreadId == null ? {} : { message_thread_id: messageThreadId }),
        parse_mode: "MarkdownV2",
      }
    );
    sentMessageIds.push(message.message_id);
  }

  return {
    chunks,
    messageIds: sentMessageIds,
    primaryMessageId: placeholderMessageId,
    controlMessageId: sentMessageIds.at(-1) ?? placeholderMessageId,
  };
}
