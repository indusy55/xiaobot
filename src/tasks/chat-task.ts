import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { assignConversationIdToMessage } from "../bot/conversation-store.js";
import {
  buildAnchoredConversationId,
  getBaseConversationId,
} from "../bot/conversation.js";
import {
  buildReplyQuoteParameters,
  extractMessageQuote,
} from "../bot/message-quote.js";
import {
  buildTaskCancelKeyboard,
  buildTaskRetryKeyboard,
} from "../bot/task-controls.js";
import {
  buildFastPathChatDecision,
  buildChatDecisionMessages,
  buildFallbackWebSearchDecision,
  buildFallbackWebpageReadDecision,
  buildFallbackChatDecision,
  buildWebSearchDecisionMessages,
  buildWebpageReadDecisionMessages,
  parseChatDecisionResponse,
  parseWebSearchDecisionResponse,
  parseWebpageReadDecisionResponse,
  sanitizeChatDecision,
  sanitizeWebSearchDecision,
  sanitizeWebpageReadDecision,
  type ChatTaskAction,
  type WebpageCandidateUrl,
} from "../infra/ai/decision.js";
import {
  readChatDecisionPrompt,
  readChatPrompt,
  readChatSearchDecisionPrompt,
  readChatWebpageDecisionPrompt,
} from "../infra/ai/prompt.js";
import {
  buildRuntimeContextPrompt,
  formatMessageSpeakerPrefix,
} from "../infra/ai/runtime-context.js";
import {
  type WebSearchContext,
} from "../infra/search/searxng.js";
import {
  formatWebpageReadPrompt,
  runReadWebpageTool,
} from "../infra/tools/read-webpage.js";
import {
  formatWebSearchPrompt,
  runWebSearchTool,
} from "../infra/tools/web-search.js";
import { resolveTelegramMessageImagePart } from "../infra/media/telegram-media.js";
import {
  isGrammyMessageNotModifiedError,
  logError,
} from "../infra/error/index.js";
import { updatePersistedMessageText } from "../bot/message-store.js";
import { deliverMarkdownV2Text } from "../bot/telegram-markdown.js";
import { TelegramMessageStreamer } from "../bot/streaming/message-streamer.js";
import { BaseTask } from "./base.js";
import type { ChatTaskPayload, TaskContextMessage } from "./types.js";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function toModelMessageContent(message: { contentType: string; textContent: string | null }) {
  if (typeof message.textContent === "string" && message.textContent.trim().length > 0) {
    return message.textContent;
  }

  return `[${message.contentType}]`;
}

async function toUserMessageContent(
  dependencies: ChatTask["dependencies"],
  message: Awaited<ReturnType<BaseTask["loadContext"]>>[number],
  signal: AbortSignal
) {
  const content = toModelMessageContent(message);
  const speakerPrefix = formatMessageSpeakerPrefix(message);
  const finalUserContent =
    speakerPrefix == null ? content : `${speakerPrefix}: ${content}`;
  const imagePart = await resolveTelegramMessageImagePart({
    api: dependencies.api,
    cacheDir: dependencies.telegramMediaCacheDir,
    rawMessage: message.rawMessage,
    contentType: message.contentType,
    signal,
  }).catch(() => null);
  const quote = extractMessageQuote(message.rawMessage);
  const quoteLine =
    quote == null ? null : `Quoted part: "${quote.text}"`;

  const textParts: { type: "text"; text: string }[] = [
    {
      type: "text",
      text: [
        finalUserContent,
        message.contentType === "sticker" && imagePart?.emoji
          ? `Sticker emoji: ${imagePart.emoji}`
          : null,
        quoteLine,
      ]
        .filter((value): value is string => value != null)
        .join("\n"),
    },
  ];

  return imagePart == null ? finalUserContent : [...textParts, imagePart];
}

async function toLangChainMessages(
  task: ChatTask,
  contextMessages: Awaited<ReturnType<BaseTask["loadContext"]>>,
  signal: AbortSignal
): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [];

  for (const message of contextMessages) {
    const content = toModelMessageContent(message);

    switch (message.role) {
      case "assistant":
        messages.push(new AIMessage(content));
        break;
      case "system":
        messages.push(new SystemMessage(content));
        break;
      case "tool":
        messages.push(new SystemMessage(`Tool output: ${content}`));
        break;
      case "user":
      default: {
        const userContent = await toUserMessageContent(
          task["dependencies"],
          message,
          signal
        );
        messages.push(new HumanMessage(userContent));
        break;
      }
    }
  }

  return messages;
}

function applyUserInputOverride(
  contextMessages: TaskContextMessage[],
  triggerTelegramMessageId: number | null,
  userInput?: string
) {
  if (!userInput || triggerTelegramMessageId == null) {
    return contextMessages;
  }

  for (let index = contextMessages.length - 1; index >= 0; index -= 1) {
    const message = contextMessages[index];
    if (!message) {
      continue;
    }

    if (
      message.role === "user" &&
      message.telegramMessageId === triggerTelegramMessageId
    ) {
      return contextMessages.map((item, itemIndex) =>
        itemIndex === index ? { ...item, textContent: userInput } : item
      );
    }
  }

  return contextMessages;
}

function findTriggerMessage(
  contextMessages: TaskContextMessage[],
  triggerTelegramMessageId: number | null
) {
  if (triggerTelegramMessageId == null) {
    return contextMessages.at(-1) ?? null;
  }

  return (
    contextMessages.find(
      (message) => message.telegramMessageId === triggerTelegramMessageId
    ) ?? null
  );
}

function extractChunkText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("");
}

function extractMessageText(content: unknown) {
  return extractChunkText(content).trim();
}

function normalizeExtractedUrl(url: string) {
  return url.replace(/[),.!?]+$/g, "").trim();
}

function extractUrlsFromText(text: string | null | undefined) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return [];
  }

  return [...text.matchAll(URL_PATTERN)]
    .map((match) => normalizeExtractedUrl(match[0] ?? ""))
    .filter((value) => value.length > 0);
}

function collectWebpageCandidateUrls(options: {
  contextMessages: TaskContextMessage[];
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
  webSearchContext: WebSearchContext | null;
}) {
  const candidates = new Map<string, WebpageCandidateUrl>();

  const pushCandidate = (
    url: string,
    source: WebpageCandidateUrl["source"],
    title?: string | null,
    snippet?: string | null
  ) => {
    if (candidates.has(url)) {
      return;
    }

    candidates.set(url, {
      url,
      source,
      ...(title == null ? {} : { title }),
      ...(snippet == null ? {} : { snippet }),
    });
  };

  const pushMessageUrls = (
    message: TaskContextMessage | null,
    source: WebpageCandidateUrl["source"]
  ) => {
    if (message == null) {
      return;
    }

    for (const url of extractUrlsFromText(message.textContent)) {
      pushCandidate(url, source);
    }
  };

  pushMessageUrls(options.triggerMessage, "trigger_message");
  pushMessageUrls(options.repliedMessage, "replied_message");

  for (const message of [...options.contextMessages].reverse()) {
    for (const url of extractUrlsFromText(message.textContent)) {
      pushCandidate(url, "conversation_message");
    }
  }

  for (const result of options.webSearchContext?.results ?? []) {
    if (!result.link) {
      continue;
    }

    pushCandidate(result.link, "search_result", result.title, result.snippet);
  }

  return [...candidates.values()].slice(0, 8);
}

function buildResponsePlanPrompt(options: {
  responseBrief: string;
  replyMode: "reply_to_message" | "send_message" | "silent";
  replyToMessageId: number | null;
  targetUserId: string | null;
}) {
  const lines = [
    "Response plan:",
    `- Action: respond`,
    `- Reply mode: ${options.replyMode}`,
  ];

  if (options.replyToMessageId != null) {
    lines.push(`- Reply target message id: ${options.replyToMessageId}`);
  }

  if (options.targetUserId != null) {
    lines.push(`- Primary target user id: ${options.targetUserId}`);
  }

  if (options.responseBrief.trim().length > 0) {
    lines.push(`- Goal: ${options.responseBrief.trim()}`);
  }

  lines.push("- Write the final user-facing message only.");
  return lines.join("\n");
}

function shouldUseStructuredDecision(options: {
  payload: ChatTaskPayload;
  triggerMessage: TaskContextMessage | null;
  repliedMessage: TaskContextMessage | null;
  recentChatMessages: TaskContextMessage[];
}) {
  const { payload, triggerMessage, repliedMessage, recentChatMessages } = options;
  if (payload.allowTaskActions === false) {
    return false;
  }

  const text = (payload.userInput ?? payload.text ?? "").trim().toLowerCase();
  const looksLikeTaskControl = /(cancel|stop|retry|task|background|queue|取消|停止|重试|任务|后台)/i
    .test(text);
  if (looksLikeTaskControl) {
    return true;
  }

  if (triggerMessage?.chatType === "private") {
    return false;
  }

  if (repliedMessage != null) {
    return false;
  }

  const activeUsers = new Set(
    recentChatMessages
      .slice(-8)
      .map((message) => message.fromId)
      .filter((value): value is string => value != null)
  );

  return activeUsers.size > 2;
}

function resolveConversationId(options: {
  currentConversationId: string;
  requestedConversation: {
    mode: "continue" | "new" | "fork_from_message";
    anchorMessageId: number | null;
  };
  fallbackAnchorMessageId: number | null;
}) {
  const { currentConversationId, requestedConversation, fallbackAnchorMessageId } = options;
  const baseConversationId = getBaseConversationId(currentConversationId);

  switch (requestedConversation.mode) {
    case "continue":
      return currentConversationId;
    case "new":
    case "fork_from_message": {
      const anchorMessageId =
        requestedConversation.anchorMessageId ?? fallbackAnchorMessageId;

      if (anchorMessageId == null) {
        return currentConversationId;
      }

      return buildAnchoredConversationId(baseConversationId, anchorMessageId);
    }
  }
}

function decisionReplyParameters(
  triggerMessage: TaskContextMessage | null,
  repliedMessage: TaskContextMessage | null,
  replyToMessageId: number | null
) {
  if (replyToMessageId == null) {
    return null;
  }

  if (
    triggerMessage?.replyToTelegramMessageId === replyToMessageId &&
    repliedMessage?.telegramMessageId === replyToMessageId
  ) {
    return buildReplyQuoteParameters({
      rawMessage: triggerMessage.rawMessage,
      replyToMessageId,
    });
  }

  return {
    message_id: replyToMessageId,
  };
}

export class ChatTask extends BaseTask {
  protected async execute(signal: AbortSignal) {
    this.ensureSignalIsActive(signal);

    const payload = this.parsePayload();
    const threadId = payload.threadId;
    const rawContextMessages = await this.loadContext(
      this.dependencies.chatContextLimit
    );
    const contextMessages = applyUserInputOverride(
      rawContextMessages,
      this.record.triggerTelegramMessageId,
      payload.userInput
    );
    const recentChatMessages = await this.loadRecentChatMessages(24, threadId);
    const triggerMessage = findTriggerMessage(
      contextMessages,
      this.record.triggerTelegramMessageId
    );
    const repliedMessage =
      triggerMessage?.replyToTelegramMessageId != null
        ? await this.loadMessageByTelegramMessageId(
            triggerMessage.replyToTelegramMessageId,
            threadId
          )
        : null;
    const runtimeContextPrompt = buildRuntimeContextPrompt({
      conversationMessages: contextMessages,
      recentChatMessages,
      triggerMessage,
      repliedMessage,
    });

    await this.dependencies.api.sendChatAction(this.record.chatId, "typing").catch(
      () => undefined
    );

    const decision = shouldUseStructuredDecision({
      payload,
      triggerMessage,
      repliedMessage,
      recentChatMessages,
    })
      ? await this.decideNextStep({
          allowTaskActions: payload.allowTaskActions !== false,
          signal,
          runtimeContextPrompt,
          contextMessages,
          recentChatMessages,
          triggerMessage,
          repliedMessage,
        })
      : buildFastPathChatDecision({
          triggerTelegramMessageId: this.record.triggerTelegramMessageId,
          triggerUserId: triggerMessage?.fromId ?? null,
        });
    const effectiveConversationId = resolveConversationId({
      currentConversationId: this.record.conversationId,
      requestedConversation: decision.conversation,
      fallbackAnchorMessageId:
        repliedMessage?.telegramMessageId ??
        this.record.triggerTelegramMessageId ??
        null,
    });
    const triggerTelegramMessageId = this.record.triggerTelegramMessageId;

    if (
      triggerTelegramMessageId != null &&
      effectiveConversationId !== this.record.conversationId
    ) {
      await assignConversationIdToMessage(
        this.record.chatId,
        triggerTelegramMessageId,
        effectiveConversationId,
        threadId
      );
    }

    const taskActionResults = await this.executeTaskActions(
      decision.taskActions,
      effectiveConversationId,
      threadId
    );

    let webSearchContext: WebSearchContext | null = null;
    let webpageReadContext: Awaited<ReturnType<typeof runReadWebpageTool>> | null =
      null;
    if (decision.action === "respond") {
      const webSearchDecision = await this.decideWebSearch({
        signal,
        runtimeContextPrompt,
        contextMessages,
        recentChatMessages,
        triggerMessage,
        repliedMessage,
        fallbackQuery: (payload.userInput ?? payload.text ?? "").trim(),
      });

      if (webSearchDecision.shouldSearch && webSearchDecision.query) {
        try {
          webSearchContext = await runWebSearchTool(webSearchDecision.query, {
            signal,
          });
        } catch (error) {
          logError("WEB_SEARCH", error, {
            taskId: this.record.id,
            chatId: this.record.chatId,
            conversationId: effectiveConversationId,
          });
        }
      }

      const webpageCandidateUrls = collectWebpageCandidateUrls({
        contextMessages,
        triggerMessage,
        repliedMessage,
        webSearchContext,
      });
      const webpageReadDecision = await this.decideWebpageRead({
        signal,
        runtimeContextPrompt,
        contextMessages,
        recentChatMessages,
        triggerMessage,
        repliedMessage,
        candidateUrls: webpageCandidateUrls,
      });

      if (webpageReadDecision.shouldRead && webpageReadDecision.url) {
        try {
          webpageReadContext = await runReadWebpageTool(webpageReadDecision.url, {
            signal,
          });
        } catch (error) {
          logError("WEBPAGE_READ", error, {
            taskId: this.record.id,
            chatId: this.record.chatId,
            conversationId: effectiveConversationId,
            url: webpageReadDecision.url,
          });
        }
      }
    }

    await this.saveContextSnapshot({
      triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      decision,
      effectiveConversationId,
      taskActionResults,
      webSearchContext,
      webpageReadContext,
      messages: contextMessages,
    });

    this.ensureSignalIsActive(signal);

    if (decision.action === "ignore") {
      return {
        action: "ignore",
        decision,
        effectiveConversationId,
        messageCount: contextMessages.length,
        responseMessageId: null,
        responseText: null,
        taskActionResults,
        triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      };
    }

    const effectiveReplyParameters = decisionReplyParameters(
      triggerMessage,
      repliedMessage,
      decision.replyMode === "reply_to_message" ? decision.replyToMessageId : null
    );

    const streamer = new TelegramMessageStreamer(this.dependencies.api, {
      chatId: this.record.chatId,
      ...(threadId == null ? {} : { messageThreadId: threadId }),
      placeholderText: "Thinking...",
      emptyText: "Thinking...",
      throttleMs: 500,
      minEditDelta: 18,
      boundaryMinDelta: 10,
      hardEditDelta: 36,
      maxPendingMs: 1200,
      sendOptions: {
        reply_markup: buildTaskCancelKeyboard(this.record.id),
      },
      editOptions: {
        reply_markup: buildTaskCancelKeyboard(this.record.id),
      },
      ...(effectiveReplyParameters != null
        ? { replyParameters: effectiveReplyParameters }
        : {}),
    });

    try {
      await streamer.start();
      if (streamer.state?.messageId != null) {
        await assignConversationIdToMessage(
          this.record.chatId,
          streamer.state.messageId,
          effectiveConversationId,
          threadId
        );
      }
      await this.throwIfCancellationRequested();
      const systemPrompt = await readChatPrompt();
      const contextModelMessages = await toLangChainMessages(
        this,
        contextMessages,
        signal
      );
      const modelMessages: BaseMessage[] = [
        new SystemMessage(systemPrompt),
        new SystemMessage(runtimeContextPrompt),
        ...(webSearchContext == null
          ? []
          : [new SystemMessage(formatWebSearchPrompt(webSearchContext))]),
        ...(webpageReadContext == null
          ? []
          : [new SystemMessage(formatWebpageReadPrompt(webpageReadContext))]),
        new SystemMessage(
          buildResponsePlanPrompt({
            responseBrief: decision.responseBrief,
            replyMode: decision.replyMode,
            replyToMessageId: decision.replyToMessageId,
            targetUserId: decision.targetUserId,
          })
        ),
        ...contextModelMessages,
      ];
      const responseMessage = await this.dependencies.chatModel.invoke(modelMessages, {
        signal,
      });
      const finalText =
        extractMessageText(responseMessage.content).length > 0
          ? extractMessageText(responseMessage.content)
          : "I could not generate a response.";
      const placeholderMessageId = streamer.state?.messageId ?? null;
      if (placeholderMessageId == null) {
        throw new Error("Missing placeholder message id");
      }
      const delivery = await deliverMarkdownV2Text({
        api: this.dependencies.api,
        chatId: this.record.chatId,
        placeholderMessageId,
        text: finalText,
        ...(threadId == null ? {} : { messageThreadId: threadId }),
        editOptions: {
          reply_markup: buildTaskCancelKeyboard(this.record.id),
        },
      });
      await streamer.complete();

      for (const messageId of delivery.messageIds.slice(1)) {
        await assignConversationIdToMessage(
          this.record.chatId,
          messageId,
          effectiveConversationId,
          threadId
        );
      }

      if (delivery.primaryMessageId != null) {
        await updatePersistedMessageText({
          chatId: this.record.chatId,
          telegramMessageId: delivery.primaryMessageId,
          textContent: delivery.chunks[0]?.rawText ?? finalText,
          ...(threadId == null ? {} : { threadId }),
        });
      }
      await this.switchReplyControls(delivery.primaryMessageId, "retry");

      return {
        action: "respond",
        decision,
        effectiveConversationId,
        messageCount: contextMessages.length,
        responseText: finalText,
        responseMessageId: delivery.primaryMessageId,
        taskActionResults,
        triggerTelegramMessageId: this.record.triggerTelegramMessageId,
      };
    } catch (error) {
      const terminalState =
        (await this.cancellationRequested())
          ? await streamer.cancel("Task cancelled.")
          : this.isTimedOut()
            ? await streamer.fail("Task timed out.")
            : await streamer.fail("Task failed.");

      if (terminalState?.messageId != null) {
        await updatePersistedMessageText({
          chatId: this.record.chatId,
          telegramMessageId: terminalState.messageId,
          textContent: terminalState.text,
          ...(threadId == null ? {} : { threadId }),
        });
      }

      await this.switchReplyControls(streamer.state?.messageId ?? null, "retry");

      if (streamer.state?.messageId != null) {
        await assignConversationIdToMessage(
          this.record.chatId,
          streamer.state.messageId,
          effectiveConversationId,
          threadId
        );
      }

      throw error;
    }
  }

  private async decideNextStep(options: {
    allowTaskActions: boolean;
    signal: AbortSignal;
    runtimeContextPrompt: string;
    contextMessages: TaskContextMessage[];
    recentChatMessages: TaskContextMessage[];
    triggerMessage: TaskContextMessage | null;
    repliedMessage: TaskContextMessage | null;
  }) {
    const {
      allowTaskActions,
      signal,
      runtimeContextPrompt,
      contextMessages,
      recentChatMessages,
      triggerMessage,
      repliedMessage,
    } = options;

    try {
      const decisionPrompt = await readChatDecisionPrompt();
      const decisionMessages = buildChatDecisionMessages({
        decisionPrompt,
        runtimeContextPrompt,
        conversationId: this.record.conversationId,
        conversationMessages: contextMessages,
        recentChatMessages,
        triggerMessage,
        repliedMessage,
      });
      const decisionSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(4000),
      ]);
      const decisionMessage = await this.dependencies.decisionModel.invoke(
        decisionMessages,
        {
          signal: decisionSignal,
        }
      );
      const rawDecision = parseChatDecisionResponse(decisionMessage);

      return sanitizeChatDecision(rawDecision, {
        allowTaskActions,
        triggerTelegramMessageId: this.record.triggerTelegramMessageId,
        triggerUserId: triggerMessage?.fromId ?? null,
        repliedTelegramMessageId: repliedMessage?.telegramMessageId ?? null,
        recentChatMessages,
      });
    } catch (error) {
      logError("CHAT_DECISION", error, {
        taskId: this.record.id,
        conversationId: this.record.conversationId,
        chatId: this.record.chatId,
      });

      return buildFallbackChatDecision(this.record.triggerTelegramMessageId);
    }
  }

  private async decideWebSearch(options: {
    signal: AbortSignal;
    runtimeContextPrompt: string;
    contextMessages: TaskContextMessage[];
    recentChatMessages: TaskContextMessage[];
    triggerMessage: TaskContextMessage | null;
    repliedMessage: TaskContextMessage | null;
    fallbackQuery: string;
  }) {
    const {
      signal,
      runtimeContextPrompt,
      contextMessages,
      recentChatMessages,
      triggerMessage,
      repliedMessage,
      fallbackQuery,
    } = options;

    if (fallbackQuery.trim().length === 0) {
      return buildFallbackWebSearchDecision();
    }

    try {
      const searchDecisionPrompt = await readChatSearchDecisionPrompt();
      const decisionMessages = buildWebSearchDecisionMessages({
        decisionPrompt: searchDecisionPrompt,
        runtimeContextPrompt,
        conversationId: this.record.conversationId,
        conversationMessages: contextMessages,
        recentChatMessages,
        triggerMessage,
        repliedMessage,
      });
      const decisionSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(2500),
      ]);
      const decisionMessage = await this.dependencies.decisionModel.invoke(
        decisionMessages,
        {
          signal: decisionSignal,
        }
      );
      const rawDecision = parseWebSearchDecisionResponse(decisionMessage);

      return sanitizeWebSearchDecision(rawDecision, {
        fallbackQuery: fallbackQuery.trim(),
      });
    } catch (error) {
      logError("WEB_SEARCH_DECISION", error, {
        taskId: this.record.id,
        conversationId: this.record.conversationId,
        chatId: this.record.chatId,
      });

      return buildFallbackWebSearchDecision();
    }
  }

  private async decideWebpageRead(options: {
    signal: AbortSignal;
    runtimeContextPrompt: string;
    contextMessages: TaskContextMessage[];
    recentChatMessages: TaskContextMessage[];
    triggerMessage: TaskContextMessage | null;
    repliedMessage: TaskContextMessage | null;
    candidateUrls: WebpageCandidateUrl[];
  }) {
    const {
      signal,
      runtimeContextPrompt,
      contextMessages,
      recentChatMessages,
      triggerMessage,
      repliedMessage,
      candidateUrls,
    } = options;

    if (candidateUrls.length === 0) {
      return buildFallbackWebpageReadDecision();
    }

    try {
      const webpageDecisionPrompt = await readChatWebpageDecisionPrompt();
      const decisionMessages = buildWebpageReadDecisionMessages({
        decisionPrompt: webpageDecisionPrompt,
        runtimeContextPrompt,
        conversationId: this.record.conversationId,
        conversationMessages: contextMessages,
        recentChatMessages,
        triggerMessage,
        repliedMessage,
        candidateUrls,
      });
      const decisionSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(2500),
      ]);
      const decisionMessage = await this.dependencies.decisionModel.invoke(
        decisionMessages,
        {
          signal: decisionSignal,
        }
      );
      const rawDecision = parseWebpageReadDecisionResponse(decisionMessage);

      return sanitizeWebpageReadDecision(rawDecision, {
        candidateUrls: candidateUrls.map((candidate) => candidate.url),
      });
    } catch (error) {
      logError("WEBPAGE_READ_DECISION", error, {
        taskId: this.record.id,
        conversationId: this.record.conversationId,
        chatId: this.record.chatId,
      });

      return buildFallbackWebpageReadDecision();
    }
  }

  private async executeTaskActions(
    taskActions: ChatTaskAction[],
    effectiveConversationId: string,
    threadId?: number
  ) {
    const results: Record<string, unknown>[] = [];

    for (const taskAction of taskActions) {
      if (taskAction.type === "cancel_task") {
        const scope =
          taskAction.scope === "latest_in_chat"
            ? {
                chatId: this.record.chatId,
                excludeTaskId: this.record.id,
                ...(this.record.userId ? { userId: this.record.userId } : {}),
              }
            : {
                chatId: this.record.chatId,
                conversationId: effectiveConversationId,
                excludeTaskId: this.record.id,
                ...(this.record.userId ? { userId: this.record.userId } : {}),
              };

        const outcome = await this.dependencies.taskRuntime.requestCancelLatest(scope);
        results.push({
          type: "cancel_task",
          scope: taskAction.scope,
          result: outcome.result,
          taskId: outcome.task?.id ?? null,
        });
        continue;
      }

      const conversationId = resolveConversationId({
        currentConversationId: effectiveConversationId,
        requestedConversation: taskAction.conversationMode,
        fallbackAnchorMessageId: this.record.triggerTelegramMessageId ?? null,
      });
      const queuedTask = await this.dependencies.taskRuntime.enqueueChatTask({
        conversationId,
        chatId: this.record.chatId,
        ...(this.record.userId ? { userId: this.record.userId } : {}),
        ...(this.record.triggerTelegramMessageId != null
          ? { triggerTelegramMessageId: this.record.triggerTelegramMessageId }
          : {}),
        payload: {
          text: taskAction.userInput,
          userInput: taskAction.userInput,
          ...(threadId == null ? {} : { threadId }),
          allowTaskActions: false,
          originTaskId: this.record.id,
        },
      });

      results.push({
        type: "enqueue_task",
        taskKind: taskAction.taskKind,
        conversationId,
        queuedTask,
      });
    }

    return results;
  }

  private parsePayload(): ChatTaskPayload {
    if (!this.record.payload) {
      return {};
    }

    try {
      const payload = JSON.parse(this.record.payload);
      return typeof payload === "object" && payload !== null
        ? (payload as ChatTaskPayload)
        : {};
    } catch {
      return {};
    }
  }

  private async switchReplyControls(
    messageId: number | null,
    mode: "cancel" | "retry"
  ) {
    if (messageId == null) {
      return;
    }

    const replyMarkup =
      mode === "cancel"
        ? buildTaskCancelKeyboard(this.record.id)
        : buildTaskRetryKeyboard(this.record.id);

    await this.dependencies.api.editMessageReplyMarkup(
      this.record.chatId,
      messageId,
      {
        reply_markup: replyMarkup,
      }
    ).catch((error) => {
      if (isGrammyMessageNotModifiedError(error)) {
        return;
      }

      logError("TASK_REPLY_CONTROLS", error, {
        taskId: this.record.id,
        messageId,
        mode,
      });
    });
  }

  private ensureSignalIsActive(signal: AbortSignal) {
    if (signal.aborted) {
      throw new Error(`Task ${this.record.id} aborted`);
    }
  }
}
