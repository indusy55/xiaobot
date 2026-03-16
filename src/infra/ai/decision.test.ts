import { describe, expect, it } from "vitest";
import {
  buildFallbackCapabilityDecision,
  buildChatDecisionMessages,
  sanitizeCapabilityDecision,
  sanitizeChatDecision,
  sanitizeWebpageReadDecision,
  sanitizeWebSearchDecision,
} from "./decision.js";

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

describe("sanitizeWebpageReadDecision", () => {
  it("keeps the selected url when it is in the candidate set", () => {
    const decision = sanitizeWebpageReadDecision(
      {
        shouldRead: true,
        url: "https://example.com/article",
        reason: "Need page content",
      },
      {
        candidateUrls: ["https://example.com/article"],
      }
    );

    expect(decision.shouldRead).toBe(true);
    expect(decision.url).toBe("https://example.com/article");
  });

  it("disables webpage reading when the model selects an unknown url", () => {
    const decision = sanitizeWebpageReadDecision(
      {
        shouldRead: true,
        url: "https://evil.example.com",
        reason: "Need page content",
      },
      {
        candidateUrls: ["https://example.com/article"],
      }
    );

    expect(decision.shouldRead).toBe(false);
    expect(decision.url).toBeNull();
  });
});

describe("sanitizeCapabilityDecision", () => {
  it("keeps a direct url only when it comes from the direct candidate set", () => {
    const decision = sanitizeCapabilityDecision(
      {
        shouldSearch: false,
        query: null,
        shouldReadWebpage: true,
        webpageReadMode: "direct_url",
        directUrl: "https://example.com/article",
        reason: "Need to inspect the page",
      },
      {
        fallbackQuery: null,
        directCandidateUrls: ["https://example.com/article"],
      }
    );

    expect(decision.shouldReadWebpage).toBe(true);
    expect(decision.webpageReadMode).toBe("direct_url");
    expect(decision.directUrl).toBe("https://example.com/article");
  });

  it("disables search_result webpage reading when search is not enabled", () => {
    const decision = sanitizeCapabilityDecision(
      {
        shouldSearch: false,
        query: null,
        shouldReadWebpage: true,
        webpageReadMode: "search_result",
        directUrl: null,
        reason: "Need page content",
      },
      {
        fallbackQuery: null,
        directCandidateUrls: [],
      }
    );

    expect(decision.shouldReadWebpage).toBe(false);
    expect(decision.webpageReadMode).toBe("none");
  });
});

describe("buildFallbackCapabilityDecision", () => {
  it("falls back to direct webpage reading when a direct candidate url exists", () => {
    const decision = buildFallbackCapabilityDecision({
      directCandidateUrls: ["https://example.com/profile"],
    });

    expect(decision.shouldReadWebpage).toBe(true);
    expect(decision.webpageReadMode).toBe("direct_url");
    expect(decision.directUrl).toBe("https://example.com/profile");
  });
});

describe("sanitizeChatDecision", () => {
  it("rejects reply targets outside the current conversation window", () => {
    const decision = sanitizeChatDecision(
      {
        action: "respond",
        replyMode: "reply_to_message",
        replyToMessageId: 999,
        targetUserId: null,
        conversation: {
          mode: "continue",
          anchorMessageId: null,
        },
        taskActions: [],
        responseBrief: "Reply to the user",
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
            createdAt: 2,
          },
        ],
      }
    );

    expect(decision.replyMode).toBe("reply_to_message");
    expect(decision.replyToMessageId).toBe(101);
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
        createdAt: 1,
      },
      repliedMessage: null,
    });

    const finalMessage = messages.at(-1);
    expect(finalMessage?.content).toContain('"candidate_reply_message_ids": [\n    101\n  ]');
    expect(finalMessage?.content).toContain('"recent_chat_messages"');
  });
});
