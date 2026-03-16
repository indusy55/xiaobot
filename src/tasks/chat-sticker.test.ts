import { describe, expect, it } from "vitest";
import {
  isDirectStickerRequest,
  pickFallbackStickerForDirectRequest,
} from "./chat-sticker.js";

describe("isDirectStickerRequest", () => {
  it("detects direct sticker requests in Chinese and English", () => {
    expect(isDirectStickerRequest("给我发个贴纸")).toBe(true);
    expect(isDirectStickerRequest("send me a sticker")).toBe(true);
    expect(isDirectStickerRequest("你好")).toBe(false);
  });
});

describe("pickFallbackStickerForDirectRequest", () => {
  it("prefers a static sticker before animated or video ones", () => {
    const sticker = pickFallbackStickerForDirectRequest([
      {
        id: 1,
        setName: "test",
        setTitle: "Test",
        fileId: "video",
        fileUniqueId: "video-1",
        emoji: "🙂",
        isAnimated: false,
        isVideo: true,
      },
      {
        id: 2,
        setName: "test",
        setTitle: "Test",
        fileId: "static",
        fileUniqueId: "static-1",
        emoji: "👍",
        isAnimated: false,
        isVideo: false,
      },
    ]);

    expect(sticker?.id).toBe(2);
  });
});
