import { describe, expect, it } from "vitest";
import { buildChatInputEnvelope } from "./input-envelope.js";

describe("buildChatInputEnvelope", () => {
  it("puts the latest request ahead of supporting context", () => {
    const envelope = buildChatInputEnvelope({
      latestRequest: {
        normalizedInput: "What changed in Telegram Bot API this week?",
        speaker: "Alice (@alice)",
        triggerMessageId: 123,
        contentType: "text",
      },
      runtimeContext: "Runtime chat context:\n- Chat type: supergroup",
      backlogSummary: "Earlier conversation summary:\n- Omitted earlier messages: 4",
      responsePlan: "Response plan:\n- Reply mode: reply_to_message",
      webSearchContext: "Fresh web search context:\n- Query: Telegram Bot API latest",
      webpageReadContext: null,
    });

    expect(envelope).toContain("[LATEST_REQUEST]");
    expect(envelope).toContain("What changed in Telegram Bot API this week?");
    expect(envelope).toContain("[RUNTIME_CONTEXT]");
    expect(envelope).toContain("[CONVERSATION_BACKLOG]");
    expect(envelope).toContain("[WEB_SEARCH_CONTEXT]");
    expect(envelope).toContain("[RESPONSE_PLAN]");
    expect(envelope).toContain("[INPUT_RULES]");
  });
});
