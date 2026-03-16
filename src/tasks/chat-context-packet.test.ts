import { describe, expect, it } from "vitest";
import { telegramActionPlanSchema } from "../infra/ai/telegram-action-schema.js";
import { buildTelegramContextPacket } from "./chat-context-packet.js";
import type { ChatToolObservationRecord } from "./chat-context.js";
import type { PreparedChatTurn } from "./chat-turn.js";
import type { TaskContextMessage } from "./types.js";

function createMessage(
  id: number,
  telegramMessageId: number,
  createdAt: number,
  overrides: Partial<TaskContextMessage> = {}
): TaskContextMessage {
  return {
    id,
    role: "user",
    chatType: "group",
    chatTitle: "Bot Test",
    contentType: "text",
    textContent: `m${telegramMessageId}`,
    rawMessage: JSON.stringify({
      message_id: telegramMessageId,
      text: `m${telegramMessageId}`,
    }),
    replyToTelegramMessageId: null,
    fromId: "1",
    fromUsername: "alice",
    fromFirstName: "Alice",
    fromLastName: null,
    fromLanguageCode: "zh",
    telegramMessageId,
    parentMessageId: null,
    referenceMessageId: null,
    createdAt,
    ...overrides,
  };
}

describe("buildTelegramContextPacket", () => {
  it("builds a valid branch-scoped packet with refs and windows", () => {
    const contextMessages: TaskContextMessage[] = [
      createMessage(1, 101, 1),
      createMessage(2, 102, 2, {
        role: "assistant",
        parentMessageId: 1,
        referenceMessageId: 1,
        fromId: "999",
        fromUsername: "bot",
        fromFirstName: "Tester",
      }),
      createMessage(3, 105, 3, {
        replyToTelegramMessageId: 102,
        parentMessageId: 2,
        referenceMessageId: 1,
        textContent: "branch root",
      }),
      createMessage(4, 106, 4, {
        role: "assistant",
        parentMessageId: 3,
        referenceMessageId: 1,
        fromId: "999",
        fromUsername: "bot",
        fromFirstName: "Tester",
      }),
    ];
    const recentChatMessages = [
      ...contextMessages,
      createMessage(5, 200, 5, {
        textContent: "other recent message",
        replyToTelegramMessageId: 106,
        parentMessageId: 4,
        referenceMessageId: 1,
      }),
    ];
    const priorToolObservations: ChatToolObservationRecord[] = [
      {
        type: "web_search",
        source: "snapshot",
        context: {
          query: "telegram markdown v2",
          answer: "Escape special characters carefully.",
          knowledge: null,
          results: [
            {
              title: "Telegram MarkdownV2",
              link: "https://core.telegram.org/bots/api#markdownv2-style",
              snippet: "Formatting rules",
              source: "telegram",
            },
          ],
        },
      },
    ];
    const preparedTurn = {
      payload: {},
      threadId: undefined,
      contextMessages,
      recentChatMessages,
      triggerMessage: contextMessages[3] ?? null,
      repliedMessage: contextMessages[2] ?? null,
      runtimeContextPrompt: "",
      latestUserInputContext: {
        normalizedInput: "continue",
        speaker: "Alice",
        triggerMessageId: 106,
        contentType: "text",
      },
      backlogSummary: null,
      priorToolObservations,
    } satisfies PreparedChatTurn;

    const packet = buildTelegramContextPacket({
      record: {
        chatId: "chat-1",
        conversationId: "chat:chat-1:anchor:101:branch:105",
        triggerTelegramMessageId: 106,
      },
      preparedTurn,
      availableStickers: [
        {
          id: 1,
          setName: "sweet_pack",
          setTitle: "Sweet Pack",
          fileId: "sticker-file-1",
          fileUniqueId: "unique-1",
          emoji: "🍬",
          isAnimated: false,
          isVideo: false,
        },
      ],
      priorToolObservations,
      currentToolObservations: [],
      allowTaskActions: true,
      now: Date.UTC(2026, 2, 16, 10, 0, 0),
    });

    expect(packet.meta.schemaVersion).toBe(1);
    expect(packet.meta.triggerRef).toBe("message_4");
    expect(packet.meta.repliedRef).toBe("message_3");
    expect(packet.runtime.chatType).toBe("group");
    expect(packet.runtime.capabilities.canSendSticker).toBe(true);
    expect(packet.windows.conversation).toEqual([
      "message_1",
      "message_2",
      "message_3",
      "message_4",
    ]);
    expect(packet.windows.reusableToolResults).toEqual(["tool_web_search_1"]);
    expect(packet.refs.conversation_active).toMatchObject({
      kind: "conversation",
      scope: "chat_branch",
    });
    expect(packet.refs.message_4).toMatchObject({
      kind: "message",
      replyToRef: null,
      parentRef: "message_3",
      branchRootRef: "message_1",
    });
    expect(packet.refs.sticker_1).toMatchObject({
      kind: "sticker",
      emoji: "🍬",
    });
  });
});

describe("telegramActionPlanSchema", () => {
  it("accepts a minimal telegram-native response plan", () => {
    const parsed = telegramActionPlanSchema.parse({
      disposition: "respond",
      conversation: {
        mode: "continue",
        anchorRef: null,
        branchRootRef: null,
      },
      operations: [
        {
          opId: "op_1",
          type: "send_message",
          replyToRef: "message_4",
          quoteRef: null,
          text: "再来一个，这次来点甜的。",
          parseMode: "MarkdownV2",
          disableWebPreview: false,
        },
        {
          opId: "op_2",
          type: "send_sticker",
          replyToRef: "message_4",
          stickerRef: "sticker_1",
        },
      ],
      usedRefs: ["message_4", "sticker_1"],
      notes: {
        summary: "reply with text and sticker",
        reasoningBrief: "user asked for another sweet sticker",
      },
    });

    expect(parsed.operations).toHaveLength(2);
    expect(parsed.operations[1]?.type).toBe("send_sticker");
  });
});
