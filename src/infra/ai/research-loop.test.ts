import { describe, expect, it } from "vitest";
import {
  sanitizeResearchDecision,
} from "./research-loop.js";

describe("sanitizeResearchDecision", () => {
  it("falls back to the latest request when search query is omitted", () => {
    const decision = sanitizeResearchDecision(
      {
        action: "search",
        query: null,
        reason: "Need more info",
      },
      {
        fallbackQuery: "DDC blog",
      }
    );

    expect(decision.action).toBe("search");
    expect(decision.query).toBe("DDC blog");
  });

  it("stops when search is requested without any usable query", () => {
    const decision = sanitizeResearchDecision(
      {
        action: "search",
        query: "   ",
        reason: "Need more info",
      },
      {
        fallbackQuery: null,
      }
    );

    expect(decision.action).toBe("done");
  });
});
