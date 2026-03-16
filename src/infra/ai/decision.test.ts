import { describe, expect, it } from "vitest";
import {
  sanitizeWebpageReadDecision,
  sanitizeWebSearchDecision,
} from "./decision.js";

describe("sanitizeWebSearchDecision", () => {
  it("falls back to the latest user query when the model omits one", () => {
    const decision = sanitizeWebSearchDecision(
      {
        version: 1,
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
        version: 1,
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
        version: 1,
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
