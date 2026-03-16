import type { StickerCatalogEntry } from "../bot/sticker-store.js";

function normalizeText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDirectStickerRequest(input: string | null | undefined) {
  const text = normalizeText(input);
  if (text == null) {
    return false;
  }

  return /(\b(sticker|stickers)\b|贴纸|表情包)/i.test(text);
}

export function pickFallbackStickerForDirectRequest(
  stickers: StickerCatalogEntry[]
) {
  if (stickers.length === 0) {
    return null;
  }

  const preferredStaticSticker =
    stickers.find((sticker) => !sticker.isAnimated && !sticker.isVideo) ?? null;

  return preferredStaticSticker ?? stickers[0] ?? null;
}
