import { describe, expect, it } from "vitest";
import { buildTelegramActionPlanFromLegacyDecision } from "./chat-action-plan.js";
import { buildTelegramContextPacket } from "./chat-context-packet.js";
import { validateTelegramActionPlan } from "./chat-plan-validator.js";
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
    rawMessage: "{}",
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

function buildPacket() {
  const contextMessages = [
    createMessage(1, 101, 1),
    createMessage(2, 102, 2, {
      role: "assistant",
      parentMessageId: 1,
      referenceMessageId: 1,
      fromId: "999",
      fromUsername: "bot",
      fromFirstName: "Tester",
    }),
    createMessage(3, 103, 3, {
      replyToTelegramMessageId: 102,
      parentMessageId: 2,
      referenceMessageId: 1,
    }),
  ];
  const preparedTurn = {
    payload: {},
    threadId: undefined,
    contextMessages,
    recentChatMessages: contextMessages,
    triggerMessage: contextMessages[2] ?? null,
    repliedMessage: contextMessages[1] ?? null,
    runtimeContextPrompt: "",
    latestUserInputContext: {
      normalizedInput: "give me another sticker",
      speaker: "Alice",
      triggerMessageId: 103,
      contentType: "text",
    },
    backlogSummary: null,
    priorToolObservations: [],
  } satisfies PreparedChatTurn;

  return buildTelegramContextPacket({
    record: {
      chatId: "chat-1",
      conversationId: "chat:chat-1:anchor:101",
      triggerTelegramMessageId: 103,
    },
    preparedTurn,
    availableStickers: [
      {
        id: 1,
        setName: "sweet_pack",
        setTitle: "Sweet Pack",
        fileId: "file-1",
        fileUniqueId: "unique-1",
        emoji: "🍬",
        isAnimated: false,
        isVideo: false,
      },
    ],
    priorToolObservations: [],
    currentToolObservations: [],
    allowTaskActions: true,
    now: Date.UTC(2026, 2, 16, 10, 0, 0),
  });
}

describe("buildTelegramActionPlanFromLegacyDecision", () => {
  it("adapts a text_with_sticker legacy decision into ordered telegram operations", () => {
    const packet = buildPacket();
    const plan = buildTelegramActionPlanFromLegacyDecision({
      packet,
      decision: {
        action: "respond",
        responseMode: "text_with_sticker",
        replyMode: "reply_to_message",
        replyToMessageId: 103,
        targetUserId: null,
        sticker: {
          send: true,
          stickerId: 1,
          reason: "cute",
        },
        conversation: {
          mode: "continue",
          anchorMessageId: null,
        },
        taskActions: [
          {
            type: "cancel_task",
            scope: "latest_in_conversation",
          },
        ],
        responseBrief: "reply with text and sticker",
        responseText: "再来一个。",
        decisionNote: "user asked for another",
      },
    });

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      "cancel_task",
      "send_message",
      "send_sticker",
    ]);
    expect(plan.usedRefs).toContain("message_3");
    expect(plan.usedRefs).toContain("sticker_1");
  });
});

describe("validateTelegramActionPlan", () => {
  it("accepts a legacy-adapted plan against the current packet", () => {
    const packet = buildPacket();
    const plan = buildTelegramActionPlanFromLegacyDecision({
      packet,
      decision: {
        action: "respond",
        responseMode: "text",
        replyMode: "reply_to_message",
        replyToMessageId: 103,
        targetUserId: null,
        sticker: {
          send: false,
          stickerId: null,
          reason: "",
        },
        conversation: {
          mode: "continue",
          anchorMessageId: null,
        },
        taskActions: [],
        responseBrief: "reply",
        responseText: "好的。",
        decisionNote: "reply",
      },
    });

    const validated = validateTelegramActionPlan({
      packet,
      plan,
    });

    expect(validated.operations).toHaveLength(1);
    expect(validated.operations[0]?.type).toBe("send_message");
  });

  it("rejects reply targets that are outside candidate reply refs", () => {
    const packet = buildPacket();
    packet.windows.candidateReplyTargets = ["message_3"];

    expect(() =>
      validateTelegramActionPlan({
        packet,
        plan: {
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
              replyToRef: "message_2",
              quoteRef: null,
              text: "好的。",
              parseMode: "MarkdownV2",
              disableWebPreview: false,
            },
          ],
          usedRefs: ["message_2"],
          notes: {
            summary: "reply",
            reasoningBrief: "reply",
          },
        },
      })
    ).toThrow("replyTo ref message_2 is not allowed in this context window");
  });

  it("rejects quotes that do not match the reply target", () => {
    const packet = buildPacket();
    const message2 = packet.refs.message_2;

    if (message2.kind !== "message") {
      throw new Error("Expected message_2 to be a message ref");
    }

    message2.quote = {
      text: "shared trunk",
      offset: 0,
      length: 12,
    };

    expect(() =>
      validateTelegramActionPlan({
        packet,
        plan: {
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
              replyToRef: "message_3",
              quoteRef: "message_2",
              text: "接着说。",
              parseMode: "MarkdownV2",
              disableWebPreview: false,
            },
          ],
          usedRefs: ["message_2", "message_3"],
          notes: {
            summary: "reply",
            reasoningBrief: "reply",
          },
        },
      })
    ).toThrow("quoteRef must match replyToRef");
  });

  it("rejects plans whose usedRefs omit referenced refs", () => {
    const packet = buildPacket();

    expect(() =>
      validateTelegramActionPlan({
        packet,
        plan: {
          disposition: "respond",
          conversation: {
            mode: "continue",
            anchorRef: null,
            branchRootRef: null,
          },
          operations: [
            {
              opId: "op_1",
              type: "send_sticker",
              replyToRef: "message_3",
              stickerRef: "sticker_1",
            },
          ],
          usedRefs: ["message_3"],
          notes: {
            summary: "sticker",
            reasoningBrief: "sticker",
          },
        },
      })
    ).toThrow("usedRefs must include referenced ref sticker_1");
  });
});
