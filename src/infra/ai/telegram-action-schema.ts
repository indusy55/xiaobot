import { z } from "zod";

export const telegramRefIdSchema = z.string().min(1).max(128);

const runtimeCapabilitiesSchema = z.object({
  canSendMessage: z.boolean(),
  canSendSticker: z.boolean(),
  canReply: z.boolean(),
  canQuote: z.boolean(),
  canEnqueueTask: z.boolean(),
  canCancelTask: z.boolean(),
});

const runtimeLimitsSchema = z.object({
  maxMessageLength: z.number().int().positive(),
  maxOperations: z.number().int().positive(),
  maxReplyDepth: z.number().int().positive(),
});

export const telegramMessageQuoteSchema = z.object({
  text: z.string().min(1).max(512),
  offset: z.number().int().nonnegative().nullable(),
  length: z.number().int().positive().nullable(),
});

const messageTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(4000),
});

const messagePhotoContentSchema = z.object({
  type: z.literal("photo"),
  assetRef: telegramRefIdSchema,
  caption: z.string().max(2000).nullable(),
});

const messageStickerContentSchema = z.object({
  type: z.literal("sticker"),
  stickerRef: telegramRefIdSchema,
  emoji: z.string().max(32).nullable(),
});

const messageLinkContentSchema = z.object({
  type: z.literal("link"),
  url: z.string().url(),
  title: z.string().max(512).nullable(),
});

const messageToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  toolRef: telegramRefIdSchema,
});

export const telegramMessageContentSchema = z.discriminatedUnion("type", [
  messageTextContentSchema,
  messagePhotoContentSchema,
  messageStickerContentSchema,
  messageLinkContentSchema,
  messageToolResultContentSchema,
]);

export const telegramChatRefSchema = z.object({
  kind: z.literal("chat"),
  telegramChatId: z.string().min(1),
  title: z.string().max(512).nullable(),
});

export const telegramConversationRefSchema = z.object({
  kind: z.literal("conversation"),
  conversationId: z.string().min(1),
  scope: z.enum(["private", "chat_anchor", "chat_branch", "chat"]),
});

export const telegramThreadRefSchema = z.object({
  kind: z.literal("thread"),
  telegramThreadId: z.number().int().positive(),
});

export const telegramUserRefSchema = z.object({
  kind: z.literal("user"),
  telegramUserId: z.string().min(1),
  username: z.string().max(128).nullable(),
  displayName: z.string().min(1).max(256),
  isBot: z.boolean(),
});

export const telegramAssetRefSchema = z.object({
  kind: z.literal("asset"),
  mediaType: z.enum(["image"]),
  mimeType: z.string().max(128).nullable(),
  localPath: z.string().max(1024).nullable(),
  source: z.enum(["telegram_cache", "derived"]),
});

export const telegramStickerRefSchema = z.object({
  kind: z.literal("sticker"),
  stickerId: z.number().int().positive(),
  telegramFileId: z.string().min(1),
  setName: z.string().min(1),
  setTitle: z.string().min(1),
  emoji: z.string().max(32).nullable(),
  tags: z.array(z.string().min(1).max(64)).max(32),
  isAnimated: z.boolean(),
  isVideo: z.boolean(),
});

export const telegramToolResultRefSchema = z.object({
  kind: z.literal("tool_result"),
  toolType: z.enum(["web_search", "webpage_read", "image_read"]),
  createdAtIso: z.string().datetime(),
  ttlSec: z.number().int().positive().nullable(),
  summary: z.string().min(1).max(4000),
  payload: z.unknown(),
});

export const telegramMessageRefSchema = z.object({
  kind: z.literal("message"),
  telegramMessageId: z.number().int().positive().nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  authorRef: telegramRefIdSchema.nullable(),
  chatRef: telegramRefIdSchema,
  threadRef: telegramRefIdSchema.nullable(),
  conversationRef: telegramRefIdSchema,
  replyToRef: telegramRefIdSchema.nullable(),
  parentRef: telegramRefIdSchema.nullable(),
  branchRootRef: telegramRefIdSchema.nullable(),
  createdAtIso: z.string().datetime(),
  content: z.array(telegramMessageContentSchema).min(1).max(16),
  quote: telegramMessageQuoteSchema.nullable(),
});

export const telegramContextRefSchema = z.discriminatedUnion("kind", [
  telegramChatRefSchema,
  telegramConversationRefSchema,
  telegramThreadRefSchema,
  telegramUserRefSchema,
  telegramMessageRefSchema,
  telegramStickerRefSchema,
  telegramToolResultRefSchema,
  telegramAssetRefSchema,
]);

export const telegramContextPacketSchema = z.object({
  meta: z.object({
    platform: z.literal("telegram"),
    chatRef: telegramRefIdSchema,
    conversationRef: telegramRefIdSchema,
    triggerRef: telegramRefIdSchema.nullable(),
    repliedRef: telegramRefIdSchema.nullable(),
    nowIso: z.string().datetime(),
    schemaVersion: z.literal(1),
  }),
  runtime: z.object({
    chatType: z.enum(["private", "group", "supergroup", "channel"]),
    threadRef: telegramRefIdSchema.nullable(),
    botUserRef: telegramRefIdSchema.nullable(),
    capabilities: runtimeCapabilitiesSchema,
    limits: runtimeLimitsSchema,
  }),
  refs: z.record(telegramRefIdSchema, telegramContextRefSchema),
  windows: z.object({
    conversation: z.array(telegramRefIdSchema),
    recentChat: z.array(telegramRefIdSchema),
    backlog: z.array(telegramRefIdSchema),
    candidateReplyTargets: z.array(telegramRefIdSchema),
    candidateAnchors: z.array(telegramRefIdSchema),
    availableStickers: z.array(telegramRefIdSchema),
    reusableToolResults: z.array(telegramRefIdSchema),
  }),
});

const sendMessageOpSchema = z.object({
  opId: z.string().min(1).max(64),
  type: z.literal("send_message"),
  replyToRef: telegramRefIdSchema.nullable(),
  quoteRef: telegramRefIdSchema.nullable(),
  text: z.string().min(1).max(12000),
  parseMode: z.enum(["MarkdownV2", "None"]),
  disableWebPreview: z.boolean(),
});

const sendStickerOpSchema = z.object({
  opId: z.string().min(1).max(64),
  type: z.literal("send_sticker"),
  replyToRef: telegramRefIdSchema.nullable(),
  stickerRef: telegramRefIdSchema,
});

const conversationModeRefSchema = z.object({
  mode: z.enum(["continue", "new", "fork_from_message"]),
  anchorRef: telegramRefIdSchema.nullable(),
  branchRootRef: telegramRefIdSchema.nullable(),
});

const enqueueTaskOpSchema = z.object({
  opId: z.string().min(1).max(64),
  type: z.literal("enqueue_task"),
  taskKind: z.literal("chat"),
  input: z.string().min(1).max(4000),
  conversation: conversationModeRefSchema,
});

const cancelTaskOpSchema = z.object({
  opId: z.string().min(1).max(64),
  type: z.literal("cancel_task"),
  scope: z.enum(["latest_in_conversation", "latest_in_chat"]),
});

export const telegramOperationSchema = z.discriminatedUnion("type", [
  sendMessageOpSchema,
  sendStickerOpSchema,
  enqueueTaskOpSchema,
  cancelTaskOpSchema,
]);

export const telegramActionPlanSchema = z.object({
  disposition: z.enum(["respond", "ignore"]),
  conversation: conversationModeRefSchema,
  operations: z.array(telegramOperationSchema).max(8),
  usedRefs: z.array(telegramRefIdSchema).max(128),
  notes: z.object({
    summary: z.string().max(500),
    reasoningBrief: z.string().max(500),
  }),
});

export type TelegramContextPacket = z.infer<typeof telegramContextPacketSchema>;
export type TelegramContextRef = z.infer<typeof telegramContextRefSchema>;
export type TelegramActionPlan = z.infer<typeof telegramActionPlanSchema>;
export type TelegramOperation = z.infer<typeof telegramOperationSchema>;
export type TelegramMessageRef = z.infer<typeof telegramMessageRefSchema>;
