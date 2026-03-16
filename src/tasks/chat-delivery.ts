import {
  assignConversationIdToMessage,
  updateMessageContextLinks,
} from "../bot/conversation-store.js";
import {
  buildTaskCancelKeyboard,
  buildTaskRetryKeyboard,
} from "../bot/task-controls.js";
import { updatePersistedMessageText } from "../bot/message-store.js";
import { TelegramMessageStreamer } from "../bot/streaming/message-streamer.js";
import { deliverMarkdownV2Text } from "../bot/telegram-markdown.js";
import {
  isGrammyMessageNotModifiedError,
  logError,
} from "../infra/error/index.js";
import type { TaskDependencies, TaskRecord } from "./types.js";

type TelegramApi = TaskDependencies["api"];
type ReplyParameters = NonNullable<
  Parameters<TelegramApi["sendMessage"]>[2]
>["reply_parameters"];

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

export function extractChatResponseText(content: unknown) {
  return extractChunkText(content).trim();
}

export class ChatResponseDelivery {
  private readonly streamer: TelegramMessageStreamer;

  constructor(
    private readonly dependencies: Pick<TaskDependencies, "api">,
    private readonly record: TaskRecord,
    private readonly options: {
      threadId?: number;
      replyParameters?: ReplyParameters | null;
    } = {}
  ) {
    this.streamer = new TelegramMessageStreamer(this.dependencies.api, {
      chatId: this.record.chatId,
      ...(this.options.threadId == null
        ? {}
        : { messageThreadId: this.options.threadId }),
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
      ...(this.options.replyParameters != null
        ? { replyParameters: this.options.replyParameters }
        : {}),
    });
  }

  get state() {
    return this.streamer.state;
  }

  async start(conversationId: string) {
    await this.streamer.start();

    if (this.streamer.state?.messageId != null) {
      await assignConversationIdToMessage(
        this.record.chatId,
        this.streamer.state.messageId,
        conversationId,
        this.options.threadId
      );
      await updateMessageContextLinks({
        chatId: this.record.chatId,
        telegramMessageId: this.streamer.state.messageId,
        conversationId,
        ...(this.options.threadId == null
          ? {}
          : { threadId: this.options.threadId }),
        parentTelegramMessageId: this.record.triggerTelegramMessageId,
        referenceTelegramMessageId: this.record.triggerTelegramMessageId,
      });
    }

    return this.streamer.state;
  }

  async deliverText(options: { conversationId: string; text: string }) {
    const placeholderMessageId = this.streamer.state?.messageId ?? null;
    if (placeholderMessageId == null) {
      throw new Error("Missing placeholder message id");
    }

    const delivery = await deliverMarkdownV2Text({
      api: this.dependencies.api,
      chatId: this.record.chatId,
      placeholderMessageId,
      text: options.text,
      ...(this.options.threadId == null
        ? {}
        : { messageThreadId: this.options.threadId }),
      editOptions: {
        reply_markup: buildTaskCancelKeyboard(this.record.id),
      },
      sendOptions: {
        reply_markup: buildTaskCancelKeyboard(this.record.id),
      },
    });

    await this.streamer.complete();

    let previousMessageId = delivery.primaryMessageId ?? null;

    for (const messageId of delivery.messageIds.slice(1)) {
      await assignConversationIdToMessage(
        this.record.chatId,
        messageId,
        options.conversationId,
        this.options.threadId
      );
      await updateMessageContextLinks({
        chatId: this.record.chatId,
        telegramMessageId: messageId,
        conversationId: options.conversationId,
        ...(this.options.threadId == null
          ? {}
          : { threadId: this.options.threadId }),
        parentTelegramMessageId: previousMessageId,
        referenceTelegramMessageId: this.record.triggerTelegramMessageId,
      });
      previousMessageId = messageId;
    }

    if (delivery.primaryMessageId != null) {
      await updatePersistedMessageText({
        chatId: this.record.chatId,
        telegramMessageId: delivery.primaryMessageId,
        textContent: delivery.chunks[0]?.rawText ?? options.text,
        ...(this.options.threadId == null
          ? {}
          : { threadId: this.options.threadId }),
      });
    }

    await this.switchReplyControls(delivery.messageIds, "retry");
    return delivery;
  }

  async deliverStickerOnly(options: { conversationId: string; fileId: string }) {
    const message = await this.dependencies.api.sendSticker(
      this.record.chatId,
      options.fileId,
      {
        ...(this.options.threadId == null
          ? {}
          : { message_thread_id: this.options.threadId }),
        ...(this.options.replyParameters == null
          ? {}
          : { reply_parameters: this.options.replyParameters }),
        reply_markup: buildTaskRetryKeyboard(this.record.id),
      }
    );

    await assignConversationIdToMessage(
      this.record.chatId,
      message.message_id,
      options.conversationId,
      this.options.threadId
    );
    await updateMessageContextLinks({
      chatId: this.record.chatId,
      telegramMessageId: message.message_id,
      conversationId: options.conversationId,
      ...(this.options.threadId == null
        ? {}
        : { threadId: this.options.threadId }),
      parentTelegramMessageId: this.record.triggerTelegramMessageId,
      referenceTelegramMessageId: this.record.triggerTelegramMessageId,
    });

    return message;
  }

  async sendSticker(options: {
    conversationId: string;
    fileId: string;
    parentTelegramMessageId: number | null;
  }) {
    const message = await this.dependencies.api.sendSticker(
      this.record.chatId,
      options.fileId,
      {
        ...(this.options.threadId == null
          ? {}
          : { message_thread_id: this.options.threadId }),
        ...(this.options.replyParameters == null
          ? {}
          : { reply_parameters: this.options.replyParameters }),
      }
    );

    await assignConversationIdToMessage(
      this.record.chatId,
      message.message_id,
      options.conversationId,
      this.options.threadId
    );
    await updateMessageContextLinks({
      chatId: this.record.chatId,
      telegramMessageId: message.message_id,
      conversationId: options.conversationId,
      ...(this.options.threadId == null
        ? {}
        : { threadId: this.options.threadId }),
      parentTelegramMessageId: options.parentTelegramMessageId,
      referenceTelegramMessageId: this.record.triggerTelegramMessageId,
    });

    return message;
  }

  async fail(options: {
    conversationId: string;
    cancellationRequested: boolean;
    timedOut: boolean;
  }) {
    const terminalState = options.cancellationRequested
      ? await this.streamer.cancel("Task cancelled.")
      : options.timedOut
        ? await this.streamer.fail("Task timed out.")
        : await this.streamer.fail("Task failed.");

    if (terminalState?.messageId != null) {
      await updatePersistedMessageText({
        chatId: this.record.chatId,
        telegramMessageId: terminalState.messageId,
        textContent: terminalState.text,
        ...(this.options.threadId == null
          ? {}
          : { threadId: this.options.threadId }),
      });
    }

    await this.switchReplyControls(
      this.streamer.state?.messageId == null ? [] : [this.streamer.state.messageId],
      "retry"
    );

    if (this.streamer.state?.messageId != null) {
      await assignConversationIdToMessage(
        this.record.chatId,
        this.streamer.state.messageId,
        options.conversationId,
        this.options.threadId
      );
    }

    return terminalState;
  }

  private async switchReplyControls(
    messageIds: number[] | number | null,
    mode: "cancel" | "retry"
  ) {
    const normalizedMessageIds =
      typeof messageIds === "number"
        ? [messageIds]
        : Array.isArray(messageIds)
          ? [...new Set(messageIds)]
          : [];

    if (normalizedMessageIds.length === 0) {
      return;
    }

    const replyMarkup =
      mode === "cancel"
        ? buildTaskCancelKeyboard(this.record.id)
        : buildTaskRetryKeyboard(this.record.id);

    await Promise.all(
      normalizedMessageIds.map((messageId) =>
        this.dependencies.api
          .editMessageReplyMarkup(this.record.chatId, messageId, {
            reply_markup: replyMarkup,
          })
          .catch((error) => {
            if (isGrammyMessageNotModifiedError(error)) {
              return;
            }

            logError("TASK_REPLY_CONTROLS", error, {
              taskId: this.record.id,
              messageId,
              mode,
            });
          })
      )
    );
  }
}
