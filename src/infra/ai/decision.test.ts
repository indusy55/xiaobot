import { describe, expect, it } from "vitest";
import {
  buildChatDecisionMessages,
  parseChatDecisionResponse,
  sanitizeChatDecision,
  sanitizeWebSearchDecision,
} from "./decision.js";
import { AIMessage } from "@langchain/core/messages";

describe("sanitizeWebSearchDecision", () => {
  it("falls back to the latest user query when the model omits one", () => {
    const decision = sanitizeWebSearchDecision(
      {
        shouldSearch: true,
        query: null,
        reason: "Need fresh info",
      },
      {
        fallbackQuery: "latest telegram bot api changes",
      }
    );

    expect(decision.shouldSearch).toBe(true);
    expect(decision.query).toBe("latest telegram bot api changes");
  });
});

describe("sanitizeChatDecision", () => {
  it("rejects reply targets outside the current conversation window", () => {
    const decision = sanitizeChatDecision(
      {
        action: "respond",
        responseMode: "sticker_only",
        replyMode: "reply_to_message",
        replyToMessageId: 999,
        targetUserId: null,
        sticker: {
          send: true,
          stickerId: 999,
          reason: "test",
        },
        conversation: {
          mode: "continue",
          anchorMessageId: null,
        },
        taskActions: [],
        responseBrief: "Reply to the user",
        responseText: "Reply to the user",
        decisionNote: "test",
      },
      {
        allowTaskActions: true,
        triggerTelegramMessageId: 101,
        triggerUserId: "1",
        repliedTelegramMessageId: null,
        conversationMessages: [
          {
            id: 1,
            role: "user",
            chatType: "group",
            chatTitle: "Test",
            contentType: "text",
            textContent: "hello",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "1",
            fromUsername: "alice",
            fromFirstName: "Alice",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 101,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 1,
          },
        ],
        recentChatMessages: [
          {
            id: 1,
            role: "user",
            chatType: "group",
            chatTitle: "Test",
            contentType: "text",
            textContent: "hello",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "1",
            fromUsername: "alice",
            fromFirstName: "Alice",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 101,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 1,
          },
          {
            id: 2,
            role: "user",
            chatType: "group",
            chatTitle: "Test",
            contentType: "text",
            textContent: "other thread",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "2",
            fromUsername: "bob",
            fromFirstName: "Bob",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 999,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 2,
          },
        ],
        availableStickerIds: new Set([1, 2]),
      }
    );

    expect(decision.replyMode).toBe("reply_to_message");
    expect(decision.replyToMessageId).toBe(101);
    expect(decision.responseMode).toBe("text");
    expect(decision.sticker.send).toBe(false);
    expect(decision.sticker.stickerId).toBeNull();
  });

  it("keeps sticker-only delivery when the sticker choice is valid", () => {
    const decision = sanitizeChatDecision(
      {
        action: "respond",
        responseMode: "sticker_only",
        replyMode: "reply_to_message",
        replyToMessageId: 101,
        targetUserId: null,
        sticker: {
          send: true,
          stickerId: 1,
          reason: "Perfect reaction",
        },
        conversation: {
          mode: "continue",
          anchorMessageId: null,
        },
        taskActions: [],
        responseBrief: "",
        responseText: "",
        decisionNote: "test",
      },
      {
        allowTaskActions: true,
        triggerTelegramMessageId: 101,
        triggerUserId: "1",
        repliedTelegramMessageId: null,
        conversationMessages: [
          {
            id: 1,
            role: "user",
            chatType: "private",
            chatTitle: null,
            contentType: "text",
            textContent: "send reaction",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "1",
            fromUsername: "alice",
            fromFirstName: "Alice",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 101,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 1,
          },
        ],
        recentChatMessages: [
          {
            id: 1,
            role: "user",
            chatType: "private",
            chatTitle: null,
            contentType: "text",
            textContent: "send reaction",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "1",
            fromUsername: "alice",
            fromFirstName: "Alice",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 101,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 1,
          },
        ],
        availableStickerIds: new Set([1, 2]),
      }
    );

    expect(decision.responseMode).toBe("sticker_only");
    expect(decision.sticker.send).toBe(true);
    expect(decision.sticker.stickerId).toBe(1);
    expect(decision.responseText).toBe("");
  });

  it("drops sticker placeholders from text responses and falls back to the brief", () => {
    const decision = sanitizeChatDecision(
      {
        action: "respond",
        responseMode: "text_with_sticker",
        replyMode: "reply_to_message",
        replyToMessageId: 101,
        targetUserId: null,
        sticker: {
          send: true,
          stickerId: 1,
          reason: "Perfect reaction",
        },
        conversation: {
          mode: "continue",
          anchorMessageId: null,
        },
        taskActions: [],
        responseBrief: "再来一个，这次给你发糖味的。",
        responseText: "[贴纸]",
        decisionNote: "test",
      },
      {
        allowTaskActions: true,
        triggerTelegramMessageId: 101,
        triggerUserId: "1",
        repliedTelegramMessageId: null,
        conversationMessages: [
          {
            id: 1,
            role: "user",
            chatType: "private",
            chatTitle: null,
            contentType: "text",
            textContent: "send reaction",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "1",
            fromUsername: "alice",
            fromFirstName: "Alice",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 101,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 1,
          },
        ],
        recentChatMessages: [
          {
            id: 1,
            role: "user",
            chatType: "private",
            chatTitle: null,
            contentType: "text",
            textContent: "send reaction",
            rawMessage: null,
            replyToTelegramMessageId: null,
            fromId: "1",
            fromUsername: "alice",
            fromFirstName: "Alice",
            fromLastName: null,
            fromLanguageCode: "en",
            telegramMessageId: 101,
            parentMessageId: null,
            referenceMessageId: null,
            createdAt: 1,
          },
        ],
        availableStickerIds: new Set([1, 2]),
      }
    );

    expect(decision.responseMode).toBe("text_with_sticker");
    expect(decision.responseText).toBe("再来一个，这次给你发糖味的。");
  });
});

describe("buildChatDecisionMessages", () => {
  it("only exposes reply candidates from the current conversation window", () => {
    const messages = buildChatDecisionMessages({
      runtimeContextPrompt: "runtime",
      conversationId: "chat:1:anchor:101",
      conversationMessages: [
        {
          id: 1,
          role: "user",
          chatType: "group",
          chatTitle: "Test",
          contentType: "text",
          textContent: "hello",
          rawMessage: null,
          replyToTelegramMessageId: null,
          fromId: "1",
          fromUsername: "alice",
          fromFirstName: "Alice",
          fromLastName: null,
          fromLanguageCode: "en",
          telegramMessageId: 101,
          parentMessageId: null,
          referenceMessageId: null,
          createdAt: 1,
        },
      ],
      recentChatMessages: [
        {
          id: 1,
          role: "user",
          chatType: "group",
          chatTitle: "Test",
          contentType: "text",
          textContent: "hello",
          rawMessage: null,
          replyToTelegramMessageId: null,
          fromId: "1",
          fromUsername: "alice",
          fromFirstName: "Alice",
          fromLastName: null,
          fromLanguageCode: "en",
          telegramMessageId: 101,
          parentMessageId: null,
          referenceMessageId: null,
          createdAt: 1,
        },
        {
          id: 2,
          role: "user",
          chatType: "group",
          chatTitle: "Test",
          contentType: "text",
          textContent: "other thread",
          rawMessage: null,
          replyToTelegramMessageId: null,
          fromId: "2",
          fromUsername: "bob",
          fromFirstName: "Bob",
          fromLastName: null,
          fromLanguageCode: "en",
          telegramMessageId: 999,
          parentMessageId: null,
          referenceMessageId: null,
          createdAt: 2,
        },
      ],
      triggerMessage: {
        id: 1,
        role: "user",
        chatType: "group",
        chatTitle: "Test",
        contentType: "text",
        textContent: "hello",
        rawMessage: null,
        replyToTelegramMessageId: null,
        fromId: "1",
        fromUsername: "alice",
        fromFirstName: "Alice",
        fromLastName: null,
        fromLanguageCode: "en",
        telegramMessageId: 101,
        parentMessageId: null,
        referenceMessageId: null,
        createdAt: 1,
      },
      repliedMessage: null,
      availableStickers: [
        {
          id: 1,
          emoji: "🙂",
          setName: "test_pack",
          setTitle: "Test Pack",
          isAnimated: false,
          isVideo: false,
        },
      ],
    });

    const finalMessage = messages.at(-1);
    expect(finalMessage?.content).toContain('"candidate_reply_message_ids": [\n    101\n  ]');
    expect(finalMessage?.content).toContain('"recent_chat_messages"');
    expect(finalMessage?.content).toContain('"available_stickers"');
  });
});

describe("parseChatDecisionResponse", () => {
  it("normalizes shorthand model output for sticker-only replies", () => {
    const message = new AIMessage(`{
      "action": "reply",
      "responseMode": "sticker",
      "replyMode": "reply",
      "reply_to_message_id": 101,
      "sticker": {
        "sticker_id": 7,
        "note": "funny reaction"
      },
      "conversation": "continue",
      "response_brief": "",
      "response_text": "",
      "decision_note": "send sticker"
    }`);

    const parsed = parseChatDecisionResponse(message);

    expect(parsed.action).toBe("respond");
    expect(parsed.responseMode).toBe("sticker_only");
    expect(parsed.replyMode).toBe("reply_to_message");
    expect(parsed.replyToMessageId).toBe(101);
    expect(parsed.sticker.send).toBe(true);
    expect(parsed.sticker.stickerId).toBe(7);
    expect(parsed.conversation.mode).toBe("continue");
    expect(parsed.taskActions).toEqual([]);
  });

  it("falls back safely for loose chinese decision values", () => {
    const message = new AIMessage(`{
      "action": "发个贴纸吧",
      "responseMode": "贴纸",
      "replyMode": "回复",
      "reply_to_message_id": "101",
      "sticker": {
        "sticker_id": "9"
      },
      "conversation": "当前对话",
      "response_text": "给你发一个",
      "response_brief": "给你发一个"
    }`);

    const parsed = parseChatDecisionResponse(message);

    expect(parsed.action).toBe("respond");
    expect(parsed.responseMode).toBe("sticker_only");
    expect(parsed.replyMode).toBe("reply_to_message");
    expect(parsed.replyToMessageId).toBe(101);
    expect(parsed.sticker.stickerId).toBe(9);
    expect(parsed.conversation.mode).toBe("continue");
    expect(parsed.responseText).toBe("给你发一个");
  });
});
