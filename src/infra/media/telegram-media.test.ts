import { describe, expect, it } from "vitest";
import { summarizeTelegramMessageMedia } from "./telegram-media.js";

describe("summarizeTelegramMessageMedia", () => {
  it("summarizes photo metadata when image embedding is skipped", () => {
    const summary = summarizeTelegramMessageMedia({
      contentType: "photo",
      rawMessage: JSON.stringify({
        photo: [
          {
            file_id: "small",
            file_unique_id: "small-1",
            width: 320,
            height: 200,
          },
          {
            file_id: "large",
            file_unique_id: "large-1",
            width: 1280,
            height: 720,
          },
        ],
      }),
    });

    expect(summary).toEqual({
      kind: "photo",
      summary: "Photo attached. Largest size is 1280x720. 2 sizes available.",
    });
  });

  it("summarizes sticker type and emoji", () => {
    const summary = summarizeTelegramMessageMedia({
      contentType: "sticker",
      rawMessage: JSON.stringify({
        sticker: {
          file_id: "sticker-1",
          file_unique_id: "unique-1",
          emoji: "🙂",
          is_animated: true,
        },
      }),
    });

    expect(summary).toEqual({
      kind: "sticker",
      summary: "Animated sticker 🙂.",
      emoji: "🙂",
    });
  });
});
