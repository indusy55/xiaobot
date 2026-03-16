import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TelegramActionPlan,
  TelegramContextPacket,
} from "../infra/ai/telegram-action-schema.js";

const {
  resolveBranchReferenceTelegramMessageId,
  deliveryInstances,
  nextMessageIdState,
} = vi.hoisted(() => ({
  resolveBranchReferenceTelegramMessageId: vi.fn(
    async ({ telegramMessageId }: { telegramMessageId: number }) =>
      telegramMessageId + 1000
  ),
  deliveryInstances: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    deliverText: ReturnType<typeof vi.fn>;
    deliverStickerOnly: ReturnType<typeof vi.fn>;
    sendSticker: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    options: unknown;
  }>,
  nextMessageIdState: { value: 700 },
}));

vi.mock("../bot/conversation-store.js", () => ({
  resolveBranchReferenceTelegramMessageId,
}));

vi.mock("./chat-delivery.js", () => {
  class MockChatResponseDelivery {
    public readonly start = vi.fn(async (_conversationId: string) => ({
      messageId: nextMessageIdState.value++,
    }));

    public readonly deliverText = vi.fn(
      async ({ text }: { conversationId: string; text: string }) => ({
        primaryMessageId: nextMessageIdState.value++,
        messageIds: [nextMessageIdState.value - 1],
        chunks: [{ rawText: text }],
      })
    );

    public readonly deliverStickerOnly = vi.fn(
      async (_options: { conversationId: string; fileId: string }) => ({
        message_id: nextMessageIdState.value++,
      })
    );

    public readonly sendSticker = vi.fn(
      async (_options: {
        conversationId: string;
        fileId: string;
        parentTelegramMessageId: number | null;
      }) => ({
        message_id: nextMessageIdState.value++,
      })
    );

    public readonly fail = vi.fn(async () => null);

    constructor(
      public readonly _dependencies: unknown,
      public readonly record: unknown,
      public readonly options: unknown
    ) {
      deliveryInstances.push(this);
    }
  }

  return {
    ChatResponseDelivery: MockChatResponseDelivery,
  };
});

import { executeTelegramActionPlan } from "./chat-plan-executor.js";

function buildPacket(): TelegramContextPacket {
  return {
    meta: {
      platform: "telegram",
      chatRef: "chat_main",
      conversationRef: "conversation_active",
      triggerRef: "message_3",
      repliedRef: "message_2",
      nowIso: new Date(Date.UTC(2026, 2, 16, 10, 0, 0)).toISOString(),
      schemaVersion: 1,
    },
    runtime: {
      chatType: "group",
      threadRef: null,
      botUserRef: null,
      capabilities: {
        canSendMessage: true,
        canSendSticker: true,
        canReply: true,
        canQuote: true,
        canEnqueueTask: true,
        canCancelTask: true,
      },
      limits: {
        maxMessageLength: 4096,
        maxOperations: 6,
        maxReplyDepth: 20,
      },
    },
    refs: {
      chat_main: {
        kind: "chat",
        telegramChatId: "chat-1",
        title: "Bot Test",
      },
      conversation_active: {
        kind: "conversation",
        conversationId: "chat:chat-1:anchor:101:branch:102",
        scope: "chat_branch",
      },
      message_1: {
        kind: "message",
        telegramMessageId: 101,
        role: "user",
        authorRef: null,
        chatRef: "chat_main",
        threadRef: null,
        conversationRef: "conversation_active",
        replyToRef: null,
        parentRef: null,
        branchRootRef: null,
        createdAtIso: new Date(Date.UTC(2026, 2, 16, 9, 58, 0)).toISOString(),
        content: [{ type: "text", text: "anchor" }],
        quote: null,
      },
      message_2: {
        kind: "message",
        telegramMessageId: 102,
        role: "assistant",
        authorRef: null,
        chatRef: "chat_main",
        threadRef: null,
        conversationRef: "conversation_active",
        replyToRef: "message_1",
        parentRef: "message_1",
        branchRootRef: "message_1",
        createdAtIso: new Date(Date.UTC(2026, 2, 16, 9, 59, 0)).toISOString(),
        content: [{ type: "text", text: "上一条回复" }],
        quote: {
          text: "上一条回复",
          offset: 2,
          length: 5,
        },
      },
      message_3: {
        kind: "message",
        telegramMessageId: 103,
        role: "user",
        authorRef: null,
        chatRef: "chat_main",
        threadRef: null,
        conversationRef: "conversation_active",
        replyToRef: "message_2",
        parentRef: "message_2",
        branchRootRef: "message_1",
        createdAtIso: new Date(Date.UTC(2026, 2, 16, 10, 0, 0)).toISOString(),
        content: [{ type: "text", text: "再来一个" }],
        quote: null,
      },
      sticker_1: {
        kind: "sticker",
        stickerId: 1,
        telegramFileId: "file-1",
        setName: "sweet_pack",
        setTitle: "Sweet Pack",
        emoji: "🍬",
        tags: ["sweet", "candy"],
        isAnimated: false,
        isVideo: false,
      },
    },
    windows: {
      conversation: ["message_1", "message_2", "message_3"],
      recentChat: ["message_1", "message_2", "message_3"],
      backlog: [],
      candidateReplyTargets: ["message_2", "message_3"],
      candidateAnchors: ["message_1", "message_2"],
      availableStickers: ["sticker_1"],
      reusableToolResults: [],
    },
  };
}

function buildPlan(
  operations: TelegramActionPlan["operations"]
): TelegramActionPlan {
  const usedRefs = new Set<string>();

  for (const operation of operations) {
    switch (operation.type) {
      case "send_message":
        if (operation.replyToRef != null) {
          usedRefs.add(operation.replyToRef);
        }
        if (operation.quoteRef != null) {
          usedRefs.add(operation.quoteRef);
        }
        break;
      case "send_sticker":
        if (operation.replyToRef != null) {
          usedRefs.add(operation.replyToRef);
        }
        usedRefs.add(operation.stickerRef);
        break;
      case "enqueue_task":
        if (operation.conversation.anchorRef != null) {
          usedRefs.add(operation.conversation.anchorRef);
        }
        if (operation.conversation.branchRootRef != null) {
          usedRefs.add(operation.conversation.branchRootRef);
        }
        break;
      case "cancel_task":
        break;
    }
  }

  return {
    disposition: "respond",
    conversation: {
      mode: "continue",
      anchorRef: null,
      branchRootRef: null,
    },
    operations,
    usedRefs: [...usedRefs],
    notes: {
      summary: "test plan",
      reasoningBrief: "test",
    },
  };
}

beforeEach(() => {
  deliveryInstances.length = 0;
  nextMessageIdState.value = 700;
  resolveBranchReferenceTelegramMessageId.mockClear();
});

describe("executeTelegramActionPlan", () => {
  it("executes text then sticker with telegram-native linkage", async () => {
    const packet = buildPacket();
    const taskRuntime = {
      enqueueChatTask: vi.fn(async () => null),
      requestCancelLatest: vi.fn(async () => ({ result: "not_found" as const, task: null })),
    };
    const plan = buildPlan([
      {
        opId: "op_message_1",
        type: "send_message",
        replyToRef: "message_2",
        quoteRef: "message_2",
        text: "这次来个真的。",
        parseMode: "MarkdownV2",
        disableWebPreview: false,
      },
      {
        opId: "op_sticker_1",
        type: "send_sticker",
        replyToRef: "message_2",
        stickerRef: "sticker_1",
      },
    ]);

    const result = await executeTelegramActionPlan({
      plan,
      packet,
      effectiveConversationId: "chat:chat-1:anchor:101:branch:102",
      dependencies: {
        api: {} as never,
        taskRuntime,
      },
      record: {
        id: 1,
        chatId: "chat-1",
        userId: "user-1",
        triggerTelegramMessageId: 103,
      },
    });

    expect(deliveryInstances).toHaveLength(2);
    expect(deliveryInstances[0]?.options).toMatchObject({
      replyParameters: {
        message_id: 102,
        quote: "上一条回复",
        quote_position: 2,
      },
      contextParentTelegramMessageId: 102,
      contextReferenceTelegramMessageId: 1102,
    });
    expect(deliveryInstances[0]?.start).toHaveBeenCalledWith(
      "chat:chat-1:anchor:101:branch:102"
    );
    expect(deliveryInstances[0]?.deliverText).toHaveBeenCalledWith({
      conversationId: "chat:chat-1:anchor:101:branch:102",
      text: "这次来个真的。",
    });
    expect(deliveryInstances[1]?.options).toMatchObject({
      replyParameters: {
        message_id: 102,
      },
      contextParentTelegramMessageId: 701,
      contextReferenceTelegramMessageId: 1102,
    });
    expect(deliveryInstances[1]?.sendSticker).toHaveBeenCalledWith({
      conversationId: "chat:chat-1:anchor:101:branch:102",
      fileId: "file-1",
      parentTelegramMessageId: 701,
    });
    expect(resolveBranchReferenceTelegramMessageId).toHaveBeenCalledTimes(2);
    expect(taskRuntime.enqueueChatTask).not.toHaveBeenCalled();
    expect(taskRuntime.requestCancelLatest).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      responseMessageId: 701,
      responseText: "这次来个真的。",
    });
    expect(result.operationResults.map((item) => item.type)).toEqual([
      "send_message",
      "send_sticker",
    ]);
  });

  it("uses sticker-only delivery when no prior output exists", async () => {
    const packet = buildPacket();
    const taskRuntime = {
      enqueueChatTask: vi.fn(async () => null),
      requestCancelLatest: vi.fn(async () => ({ result: "not_found" as const, task: null })),
    };
    const plan = buildPlan([
      {
        opId: "op_sticker_1",
        type: "send_sticker",
        replyToRef: "message_2",
        stickerRef: "sticker_1",
      },
    ]);

    const result = await executeTelegramActionPlan({
      plan,
      packet,
      effectiveConversationId: "chat:chat-1:anchor:101:branch:102",
      dependencies: {
        api: {} as never,
        taskRuntime,
      },
      record: {
        id: 1,
        chatId: "chat-1",
        userId: "user-1",
        triggerTelegramMessageId: 103,
      },
    });

    expect(deliveryInstances).toHaveLength(1);
    expect(deliveryInstances[0]?.deliverStickerOnly).toHaveBeenCalledWith({
      conversationId: "chat:chat-1:anchor:101:branch:102",
      fileId: "file-1",
    });
    expect(deliveryInstances[0]?.sendSticker).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      responseMessageId: 700,
      responseText: null,
    });
  });

  it("executes task operations without requiring message delivery", async () => {
    const packet = buildPacket();
    const taskRuntime = {
      enqueueChatTask: vi.fn(async (input) => ({ id: 99, ...input })),
      requestCancelLatest: vi.fn(async () => ({
        result: "requested" as const,
        task: { id: 88 },
      })),
    };
    const plan = buildPlan([
      {
        opId: "op_cancel_1",
        type: "cancel_task",
        scope: "latest_in_chat",
      },
      {
        opId: "op_enqueue_1",
        type: "enqueue_task",
        taskKind: "chat",
        input: "继续刚才那个话题",
        conversation: {
          mode: "fork_from_message",
          anchorRef: "message_1",
          branchRootRef: "message_2",
        },
      },
    ]);

    const result = await executeTelegramActionPlan({
      plan,
      packet,
      effectiveConversationId: "chat:chat-1:anchor:101",
      dependencies: {
        api: {} as never,
        taskRuntime,
      },
      record: {
        id: 12,
        chatId: "chat-1",
        userId: "user-1",
        triggerTelegramMessageId: 103,
      },
      threadId: 7,
    });

    expect(taskRuntime.requestCancelLatest).toHaveBeenCalledWith({
      chatId: "chat-1",
      excludeTaskId: 12,
      userId: "user-1",
    });
    expect(taskRuntime.enqueueChatTask).toHaveBeenCalledWith({
      conversationId: "chat:chat-1:anchor:101:branch:102",
      chatId: "chat-1",
      userId: "user-1",
      triggerTelegramMessageId: 103,
      payload: {
        text: "继续刚才那个话题",
        userInput: "继续刚才那个话题",
        threadId: 7,
        allowTaskActions: false,
        originTaskId: 12,
      },
    });
    expect(deliveryInstances).toHaveLength(0);
    expect(result.responseMessageId).toBeNull();
    expect(result.responseText).toBeNull();
    expect(result.operationResults.map((item) => item.type)).toEqual([
      "cancel_task",
      "enqueue_task",
    ]);
  });
});
