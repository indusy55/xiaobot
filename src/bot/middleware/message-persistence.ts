import type { Bot } from "grammy";
import { db } from "../../db/index.js";
import {
  chatParticipantsTable,
  chatsTable,
  messagesTable,
  usersTable,
} from "../../db/schema.js";
import { logError } from "../../infra/error/index.js";
import { buildConversationId } from "../conversation.js";

type TelegramEntity = Record<string, unknown>;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TelegramMessageLike = TelegramEntity & { message_id: number; date: number };

const OUTGOING_MESSAGE_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendVoice",
  "sendAudio",
  "sendDocument",
  "sendAnimation",
  "sendSticker",
  "sendVideoNote",
  "sendLocation",
  "sendContact",
  "sendPoll",
  "sendDice",
  "sendVenue",
  "forwardMessage",
  "sendGame",
  "sendInvoice",
]);

function getContentType(message: TelegramEntity) {
  if (typeof message.text === "string") return "text";
  if (Array.isArray(message.photo)) return "photo";
  if (message.video) return "video";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.document) return "document";
  if (message.sticker) return "sticker";
  if (message.location) return "location";
  if (message.contact) return "contact";
  if (message.poll) return "poll";
  if (message.venue) return "venue";
  if (message.dice) return "dice";
  if (message.video_note) return "video_note";
  if (message.animation) return "animation";
  return "unknown";
}

function getTextContent(message: TelegramEntity) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.caption === "string") return message.caption;
  const poll = asEntity(message.poll);
  if (typeof poll?.question === "string") return poll.question;
  const sticker = asEntity(message.sticker);
  if (typeof sticker?.emoji === "string") return sticker.emoji;
  return undefined;
}

function getChatTitle(chat: TelegramEntity) {
  return typeof chat.title === "string" ? chat.title : undefined;
}

function getChatUsername(chat: TelegramEntity) {
  return typeof chat.username === "string" ? chat.username : undefined;
}

function getChatType(chat: TelegramEntity) {
  return typeof chat.type === "string" ? chat.type : "private";
}

function getUserBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function getUserValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asEntity(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as TelegramEntity)
    : undefined;
}

function getMessageId(message: TelegramEntity) {
  return typeof message.message_id === "number" ? message.message_id : undefined;
}

function getMessageDate(message: TelegramEntity) {
  return typeof message.date === "number" ? message.date : Date.now() / 1000;
}

function getReplyToMessageId(message: TelegramEntity) {
  const reply = asEntity(message.reply_to_message);
  return reply && typeof reply.message_id === "number"
    ? reply.message_id
    : undefined;
}

function isMessageLike(value: unknown): value is TelegramMessageLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TelegramEntity).message_id === "number" &&
    typeof (value as TelegramEntity).date === "number"
  );
}

async function upsertChat(tx: DbTransaction, chat: TelegramEntity, now: number) {
  await tx
    .insert(chatsTable)
    .values({
      id: String(chat.id),
      type: getChatType(chat),
      title: getChatTitle(chat),
      lastKnownUsername: getChatUsername(chat),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: chatsTable.id,
      set: {
        type: getChatType(chat),
        title: getChatTitle(chat),
        lastKnownUsername: getChatUsername(chat),
        updatedAt: now,
      },
    });
}

async function upsertUser(
  tx: DbTransaction,
  from: TelegramEntity | undefined,
  now: number
) {
  if (!from) {
    return;
  }

  await tx
    .insert(usersTable)
    .values({
      id: String(from.id),
      lastKnownUsername: getUserValue(from.username),
      firstName: getUserValue(from.first_name),
      lastName: getUserValue(from.last_name),
      languageCode: getUserValue(from.language_code),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        lastKnownUsername: getUserValue(from.username),
        firstName: getUserValue(from.first_name),
        lastName: getUserValue(from.last_name),
        languageCode: getUserValue(from.language_code),
        updatedAt: now,
      },
    });
}

async function upsertChatParticipant(
  tx: DbTransaction,
  chat: TelegramEntity,
  from: TelegramEntity | undefined,
  options: {
    now: number;
    seenAt: number;
  }
) {
  if (!from) {
    return;
  }

  await tx
    .insert(chatParticipantsTable)
    .values({
      chatId: String(chat.id),
      userId: String(from.id),
      observedUsername: getUserValue(from.username),
      observedFirstName: getUserValue(from.first_name),
      observedLastName: getUserValue(from.last_name),
      observedLanguageCode: getUserValue(from.language_code),
      isBot: getUserBoolean(from.is_bot) ?? false,
      firstSeenAt: options.seenAt,
      lastSeenAt: options.seenAt,
      createdAt: options.now,
      updatedAt: options.now,
    })
    .onConflictDoUpdate({
      target: [chatParticipantsTable.chatId, chatParticipantsTable.userId],
      set: {
        observedUsername: getUserValue(from.username),
        observedFirstName: getUserValue(from.first_name),
        observedLastName: getUserValue(from.last_name),
        observedLanguageCode: getUserValue(from.language_code),
        isBot: getUserBoolean(from.is_bot) ?? false,
        lastSeenAt: options.seenAt,
        updatedAt: options.now,
      },
    });
}

async function persistMessage(message: TelegramEntity, options: {
  rawMessage: string;
  role: "user" | "assistant" | "system" | "tool";
  status: "received" | "sent" | "error";
  telegramUpdateId?: number;
  replyToTelegramMessageId?: number;
}) {
  const chat = asEntity(message.chat);
  const from = asEntity(message.from);
  if (!chat) {
    throw new Error("Message chat is missing");
  }
  const now = Date.now();
  const messageCreatedAt = getMessageDate(message) * 1000;
  const chatId = String(chat.id);
  const userId = from ? String(from.id) : undefined;
  const threadId =
    typeof message.message_thread_id === "number"
      ? message.message_thread_id
      : undefined;

  await db.transaction(async (tx) => {
    await upsertChat(tx, chat, now);
    await upsertUser(tx, from, now);
    await upsertChatParticipant(tx, chat, from, {
      now,
      seenAt: messageCreatedAt,
    });

    await tx.insert(messagesTable).values({
      conversationId: buildConversationId(chatId, getChatType(chat), threadId),
      chatId,
      userId,
      chatType: getChatType(chat),
      chatTitle: getChatTitle(chat),
      threadId,
      telegramMessageId: getMessageId(message),
      telegramUpdateId: options.telegramUpdateId,
      replyToTelegramMessageId:
        options.replyToTelegramMessageId ?? getReplyToMessageId(message),
      role: options.role,
      contentType: getContentType(message),
      fromId: userId,
      fromUsername: from ? getUserValue(from.username) : undefined,
      fromFirstName: from ? getUserValue(from.first_name) : undefined,
      fromLastName: from ? getUserValue(from.last_name) : undefined,
      fromLanguageCode: from ? getUserValue(from.language_code) : undefined,
      textContent: getTextContent(message),
      rawMessage: options.rawMessage,
      status: options.status,
      createdAt: messageCreatedAt,
    });
  });
}

export function setupMessagePersistenceMiddleware(bot: Bot) {
  bot.on("message", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const userId = ctx.from ? String(ctx.from.id) : undefined;

    try {
      await persistMessage(ctx.msg as unknown as TelegramEntity, {
        rawMessage: JSON.stringify(ctx.msg),
        role: "user",
        status: "received",
        telegramUpdateId: ctx.update.update_id,
      });
    } catch (error) {
      logError("MESSAGE_PERSISTENCE", error, {
        chatId,
        userId,
        updateId: ctx.update.update_id,
        telegramMessageId: ctx.msg.message_id,
      });
    }

    return next();
  });

  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);

    if (!OUTGOING_MESSAGE_METHODS.has(method)) {
      return result;
    }

    if (!isMessageLike(result)) {
      return result;
    }

    const outgoingMessage = result as TelegramMessageLike;
    const outgoingPayload = payload as TelegramEntity;

    try {
      await persistMessage(outgoingMessage, {
        rawMessage: JSON.stringify({
          method,
          payload: outgoingPayload,
          message: outgoingMessage,
        }),
        role: "assistant",
        status: "sent",
        ...((() => {
          const replyToTelegramMessageId =
            (asEntity(outgoingPayload.reply_parameters)?.message_id as
              | number
              | undefined) ??
            (typeof outgoingPayload.reply_to_message_id === "number"
              ? outgoingPayload.reply_to_message_id
              : undefined);

          return replyToTelegramMessageId === undefined
            ? {}
            : { replyToTelegramMessageId };
        })()),
      });
    } catch (error) {
      logError("OUTGOING_MESSAGE_PERSISTENCE", error, {
        method,
        chatId: outgoingPayload.chat_id,
        telegramMessageId: outgoingMessage.message_id,
      });
    }

    return result;
  });
}
