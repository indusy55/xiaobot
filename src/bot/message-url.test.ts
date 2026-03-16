import { describe, expect, it } from "vitest";
import { extractUrlsFromRawMessage } from "./message-url.js";

describe("extractUrlsFromRawMessage", () => {
  it("extracts text_link urls from stored raw telegram messages", () => {
    const rawMessage = JSON.stringify({
      text: "click here",
      entities: [
        {
          type: "text_link",
          offset: 0,
          length: 10,
          url: "https://example.com/article",
        },
      ],
    });

    expect(extractUrlsFromRawMessage(rawMessage)).toEqual([
      "https://example.com/article",
    ]);
  });

  it("extracts urls from wrapped outgoing stored messages", () => {
    const rawMessage = JSON.stringify({
      method: "sendMessage",
      message: {
        text: "docs",
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 4,
            url: "https://example.com/docs",
          },
        ],
      },
    });

    expect(extractUrlsFromRawMessage(rawMessage)).toEqual([
      "https://example.com/docs",
    ]);
  });
});
