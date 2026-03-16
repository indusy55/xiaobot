import { describe, expect, it } from "vitest";
import { buildConversationBacklogSummary } from "./conversation-summary.js";

describe("buildConversationBacklogSummary", () => {
  it("formats a compact summary for older omitted messages", () => {
    const summary = buildConversationBacklogSummary([
      {
        id: 1,
        role: "user",
        chatType: "private",
        chatTitle: null,
        contentType: "text",
        textContent: "Earlier question about deployment",
        rawMessage: null,
        replyToTelegramMessageId: null,
        fromId: "1",
        fromUsername: "alice",
        fromFirstName: "Alice",
        fromLastName: null,
        fromLanguageCode: "en",
        telegramMessageId: 10,
        createdAt: 1,
      },
      {
        id: 2,
        role: "assistant",
        chatType: "private",
        chatTitle: null,
        contentType: "text",
        textContent: "Earlier answer about deployment",
        rawMessage: null,
        replyToTelegramMessageId: null,
        fromId: null,
        fromUsername: null,
        fromFirstName: null,
        fromLastName: null,
        fromLanguageCode: null,
        telegramMessageId: 11,
        createdAt: 2,
      },
    ]);

    expect(summary).toContain("Earlier conversation summary:");
    expect(summary).toContain("Omitted earlier messages: 2");
    expect(summary).toContain("Alice (@alice)");
    expect(summary).toContain("Assistant: Earlier answer about deployment");
  });
});
