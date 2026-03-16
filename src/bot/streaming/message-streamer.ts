import type { Api, RawApi } from "grammy";
import { isGrammyMessageNotModifiedError } from "../../infra/error/index.js";

type TelegramApi = Api<RawApi>;
type SendMessageOptions = NonNullable<
  Parameters<TelegramApi["sendMessage"]>[2]
>;
type EditMessageTextOptions = NonNullable<
  Parameters<TelegramApi["editMessageText"]>[3]
>;

export interface TelegramMessageStreamerOptions {
  chatId: number | string;
  messageThreadId?: number;
  replyToMessageId?: number;
  replyParameters?: SendMessageOptions["reply_parameters"];
  throttleMs?: number;
  minEditDelta?: number;
  boundaryMinDelta?: number;
  hardEditDelta?: number;
  maxPendingMs?: number;
  placeholderText?: string;
  emptyText?: string;
  sendOptions?: SendMessageOptions;
  editOptions?: EditMessageTextOptions;
}

export interface TelegramMessageStreamState {
  chatId: number | string;
  messageId: number;
  text: string;
}

export class TelegramMessageStreamer {
  private readonly throttleMs: number;
  private readonly minEditDelta: number;
  private readonly boundaryMinDelta: number;
  private readonly hardEditDelta: number;
  private readonly maxPendingMs: number;
  private readonly placeholderText: string;
  private readonly emptyText: string;
  private readonly sendOptions: SendMessageOptions;
  private readonly editOptions: EditMessageTextOptions;

  private text = "";
  private messageId: number | null = null;
  private lastRenderedText: string | null = null;
  private lastFlushAt = 0;
  private pendingSince = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isClosed = false;

  constructor(
    private readonly api: TelegramApi,
    private readonly options: TelegramMessageStreamerOptions
  ) {
    this.throttleMs = options.throttleMs ?? 800;
    this.minEditDelta = options.minEditDelta ?? 40;
    this.boundaryMinDelta =
      options.boundaryMinDelta ?? Math.max(Math.floor(this.minEditDelta / 2), 16);
    this.hardEditDelta = options.hardEditDelta ?? this.minEditDelta * 2;
    this.maxPendingMs = options.maxPendingMs ?? 2000;
    this.placeholderText = options.placeholderText ?? "...";
    this.emptyText = options.emptyText ?? this.placeholderText;
    this.sendOptions = this.buildSendOptions();
    this.editOptions = options.editOptions ?? {};
  }

  get state(): TelegramMessageStreamState | null {
    if (this.messageId == null) {
      return null;
    }

    return {
      chatId: this.options.chatId,
      messageId: this.messageId,
      text: this.text,
    };
  }

  async start(initialText = "") {
    this.ensureOpen();

    if (this.messageId != null) {
      return this.state!;
    }

    this.text = initialText;
    const firstText = this.getRenderableText(this.text);
    const message = await this.api.sendMessage(
      this.options.chatId,
      firstText,
      this.sendOptions
    );

    this.messageId = message.message_id;
    this.lastRenderedText = firstText;
    this.lastFlushAt = Date.now();
    this.pendingSince = 0;

    return this.state!;
  }

  async push(delta: string) {
    this.ensureOpen();
    if (!delta) {
      return this.state;
    }

    this.text += delta;
    this.markDirty();
    await this.scheduleFlush();
    return this.state;
  }

  async replace(text: string) {
    this.ensureOpen();
    this.text = text;
    this.markDirty();
    await this.scheduleFlush();
    return this.state;
  }

  async flush(force = false) {
    this.ensureOpen();
    await this.flushNow(force);
    return this.state;
  }

  async complete(finalText?: string) {
    this.ensureOpen();
    if (finalText !== undefined) {
      this.text = finalText;
    }

    await this.flushNow(true);
    this.isClosed = true;
    this.clearTimer();
    return this.state;
  }

  async fail(errorText: string) {
    this.ensureOpen();
    this.text = errorText;
    await this.flushNow(true);
    this.isClosed = true;
    this.clearTimer();
    return this.state;
  }

  async cancel(cancelText?: string) {
    this.ensureOpen();
    if (cancelText !== undefined) {
      this.text = cancelText;
    }

    await this.flushNow(true);
    this.isClosed = true;
    this.clearTimer();
    return this.state;
  }

  private async scheduleFlush() {
    if (this.messageId == null) {
      await this.start(this.text);
      return;
    }

    if (this.shouldFlushNow()) {
      await this.flushNow();
      return;
    }

    if (this.flushTimer != null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const nextDelay = this.getNextFlushDelay();
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushNow()
          .then(() => resolve())
          .catch(reject);
      }, nextDelay);
    });
  }

  private async flushNow(force = false) {
    if (this.messageId == null) {
      await this.start(this.text);
      return;
    }

    const nextText = this.getRenderableText(this.text);
    if (nextText === this.lastRenderedText) {
      return;
    }

    if (!force && !this.shouldFlushText(nextText)) {
      await this.scheduleFlush();
      return;
    }

    try {
      await this.api.editMessageText(
        this.options.chatId,
        this.messageId,
        nextText,
        this.editOptions
      );
    } catch (error) {
      if (!isGrammyMessageNotModifiedError(error)) {
        throw error;
      }
    }

    this.lastRenderedText = nextText;
    this.lastFlushAt = Date.now();
    this.pendingSince = 0;
  }

  private buildSendOptions(): SendMessageOptions {
    const replyParameters =
      this.options.replyParameters != null
        ? { reply_parameters: this.options.replyParameters }
        : this.options.replyToMessageId == null
          ? {}
          : { reply_parameters: { message_id: this.options.replyToMessageId } };

    const threadOptions =
      this.options.messageThreadId == null
        ? {}
        : { message_thread_id: this.options.messageThreadId };

    return {
      ...this.options.sendOptions,
      ...replyParameters,
      ...threadOptions,
    };
  }

  private getRenderableText(text: string) {
    return text.length > 0 ? text : this.emptyText;
  }

  private getPendingDelta(nextText = this.getRenderableText(this.text)) {
    return Math.abs(nextText.length - (this.lastRenderedText?.length ?? 0));
  }

  private hasBoundary(nextText = this.getRenderableText(this.text)) {
    const previousLength = this.lastRenderedText?.length ?? 0;
    const appendedText = nextText.slice(previousLength);
    return /[.!?。！？\n]/.test(appendedText);
  }

  private shouldFlushNow() {
    const elapsedSinceLastFlush = Date.now() - this.lastFlushAt;
    return elapsedSinceLastFlush >= this.throttleMs && this.shouldFlushText();
  }

  private shouldFlushText(nextText = this.getRenderableText(this.text)) {
    if (nextText === this.lastRenderedText) {
      return false;
    }

    const pendingDelta = this.getPendingDelta(nextText);
    if (pendingDelta >= this.hardEditDelta) {
      return true;
    }

    if (pendingDelta >= this.boundaryMinDelta && this.hasBoundary(nextText)) {
      return true;
    }

    if (pendingDelta >= this.minEditDelta && /\n\n/.test(nextText)) {
      return true;
    }

    if (this.pendingSince > 0 && Date.now() - this.pendingSince >= this.maxPendingMs) {
      return true;
    }

    return false;
  }

  private getNextFlushDelay() {
    const now = Date.now();
    const elapsedSinceLastFlush = now - this.lastFlushAt;
    const elapsedSincePending = this.pendingSince > 0 ? now - this.pendingSince : 0;
    const waitForThrottle = Math.max(this.throttleMs - elapsedSinceLastFlush, 0);
    const waitForPending = Math.max(this.maxPendingMs - elapsedSincePending, 0);

    if (this.pendingSince === 0) {
      return waitForThrottle;
    }

    return Math.max(Math.min(waitForThrottle, waitForPending), 50);
  }

  private markDirty() {
    if (this.pendingSince === 0) {
      this.pendingSince = Date.now();
    }
  }

  private clearTimer() {
    if (this.flushTimer == null) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private ensureOpen() {
    if (this.isClosed) {
      throw new Error("TelegramMessageStreamer is already closed");
    }
  }
}
