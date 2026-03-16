import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppApi } from "../../bot/types.js";

type TelegramEntity = Record<string, unknown>;
type ModelImagePart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

export interface TelegramMediaSummary {
  kind: "photo" | "sticker";
  summary: string;
  emoji?: string;
}

type MediaReference = {
  fileId: string;
  fileUniqueId: string;
  kind: "photo" | "sticker";
  emoji?: string;
};

const dataUrlCache = new Map<string, string>();

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("This operation was aborted", "AbortError");
  }
}

function asEntity(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as TelegramEntity)
    : undefined;
}

function asEntities(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => asEntity(item))
        .filter((item): item is TelegramEntity => item !== undefined)
    : [];
}

function getStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function getBooleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function getNumberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function unwrapStoredMessage(rawMessage: string) {
  try {
    const parsed = JSON.parse(rawMessage);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const parsedEntity = parsed as TelegramEntity;
    const nestedMessage = asEntity(parsedEntity.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    return parsedEntity;
  } catch {
    return null;
  }
}

function selectLargestPhoto(message: TelegramEntity): MediaReference | null {
  const photos = asEntities(message.photo);
  if (photos.length === 0) {
    return null;
  }

  const bestPhoto = photos
    .slice()
    .sort((left, right) => {
      const leftArea = (getNumberValue(left.width) ?? 0) * (getNumberValue(left.height) ?? 0);
      const rightArea =
        (getNumberValue(right.width) ?? 0) * (getNumberValue(right.height) ?? 0);

      if (rightArea !== leftArea) {
        return rightArea - leftArea;
      }

      return (getNumberValue(right.file_size) ?? 0) - (getNumberValue(left.file_size) ?? 0);
    })[0];

  if (!bestPhoto) {
    return null;
  }

  const fileId = getStringValue(bestPhoto.file_id);
  const fileUniqueId = getStringValue(bestPhoto.file_unique_id);
  if (!fileId || !fileUniqueId) {
    return null;
  }

  return {
    fileId,
    fileUniqueId,
    kind: "photo",
  };
}

function selectStickerMedia(message: TelegramEntity): MediaReference | null {
  const sticker = asEntity(message.sticker);
  if (!sticker) {
    return null;
  }

  const emoji = getStringValue(sticker.emoji);
  const isAnimated = getBooleanValue(sticker.is_animated) ?? false;
  const isVideo = getBooleanValue(sticker.is_video) ?? false;
  const thumbnail = asEntity(sticker.thumbnail);

  if ((isAnimated || isVideo) && thumbnail) {
    const fileId = getStringValue(thumbnail.file_id);
    const fileUniqueId = getStringValue(thumbnail.file_unique_id);
    if (fileId && fileUniqueId) {
      return {
        fileId,
        fileUniqueId,
        kind: "sticker",
        ...(emoji ? { emoji } : {}),
      };
    }
  }

  const fileId = getStringValue(sticker.file_id);
  const fileUniqueId = getStringValue(sticker.file_unique_id);
  if (!fileId || !fileUniqueId) {
    return null;
  }

  return {
    fileId,
    fileUniqueId,
    kind: "sticker",
    ...(emoji ? { emoji } : {}),
  };
}

function getMediaReference(rawMessage: string, contentType: string) {
  const message = unwrapStoredMessage(rawMessage);
  if (!message) {
    return null;
  }

  switch (contentType) {
    case "photo":
      return selectLargestPhoto(message);
    case "sticker":
      return selectStickerMedia(message);
    default:
      return null;
  }
}

export function summarizeTelegramMessageMedia(options: {
  rawMessage: string | null;
  contentType: string;
}): TelegramMediaSummary | null {
  const { rawMessage, contentType } = options;
  if (!rawMessage) {
    return null;
  }

  const message = unwrapStoredMessage(rawMessage);
  if (!message) {
    return null;
  }

  if (contentType === "photo") {
    const photos = asEntities(message.photo);
    const largestPhoto = photos
      .slice()
      .sort((left, right) => {
        const leftArea =
          (getNumberValue(left.width) ?? 0) * (getNumberValue(left.height) ?? 0);
        const rightArea =
          (getNumberValue(right.width) ?? 0) * (getNumberValue(right.height) ?? 0);

        if (rightArea !== leftArea) {
          return rightArea - leftArea;
        }

        return (getNumberValue(right.file_size) ?? 0) -
          (getNumberValue(left.file_size) ?? 0);
      })[0];
    const width = getNumberValue(largestPhoto?.width);
    const height = getNumberValue(largestPhoto?.height);
    const dimensionText =
      width && height ? ` Largest size is ${width}x${height}.` : "";
    const variantText = photos.length > 1 ? ` ${photos.length} sizes available.` : "";

    return {
      kind: "photo",
      summary: `Photo attached.${dimensionText}${variantText}`.trim(),
    };
  }

  if (contentType === "sticker") {
    const sticker = asEntity(message.sticker);
    if (!sticker) {
      return null;
    }

    const emoji = getStringValue(sticker.emoji);
    const isAnimated = getBooleanValue(sticker.is_animated) ?? false;
    const isVideo = getBooleanValue(sticker.is_video) ?? false;
    const stickerMode = isVideo
      ? "Video sticker"
      : isAnimated
        ? "Animated sticker"
        : "Sticker";

    return {
      kind: "sticker",
      summary: `${stickerMode}${emoji ? ` ${emoji}` : ""}.`,
      ...(emoji ? { emoji } : {}),
    };
  }

  return null;
}

function inferMimeType(filePath: string, kind: "photo" | "sticker") {
  const extension = extname(filePath).toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return kind === "sticker" ? "image/webp" : "image/jpeg";
  }
}

async function ensureCachedTelegramFile(options: {
  api: AppApi;
  cacheDir: string;
  media: MediaReference;
  signal?: AbortSignal;
}) {
  const { api, cacheDir, media, signal } = options;
  throwIfAborted(signal);
  const telegramFile = await api.getFile(media.fileId);
  if (!telegramFile.file_path) {
    return null;
  }

  const extension = extname(telegramFile.file_path) || (media.kind === "sticker" ? ".webp" : ".jpg");
  const targetDir = join(cacheDir, media.kind);
  const targetPath = join(targetDir, `${media.fileUniqueId}${extension}`);

  try {
    const existing = await stat(targetPath);
    if (existing.isFile() && existing.size > 0) {
      return {
        path: targetPath,
        mimeType: inferMimeType(telegramFile.file_path, media.kind),
      };
    }
  } catch {
    // Cache miss.
  }

  throwIfAborted(signal);
  await mkdir(targetDir, { recursive: true });
  const downloadedPath = await telegramFile.download(targetPath);
  throwIfAborted(signal);

  return {
    path: downloadedPath,
    mimeType: inferMimeType(downloadedPath, media.kind),
  };
}

async function toDataUrl(path: string, mimeType: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const cacheKey = `${mimeType}:${path}`;
  const cachedValue = dataUrlCache.get(cacheKey);
  if (cachedValue) {
    return cachedValue;
  }

  const fileBuffer = await readFile(path);
  throwIfAborted(signal);
  const dataUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
  dataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

export async function resolveTelegramMessageImagePart(options: {
  api: AppApi;
  cacheDir: string;
  rawMessage: string | null;
  contentType: string;
  signal?: AbortSignal;
}): Promise<(ModelImagePart & { emoji?: string }) | null> {
  const { api, cacheDir, rawMessage, contentType, signal } = options;
  throwIfAborted(signal);
  if (!rawMessage) {
    return null;
  }

  const media = getMediaReference(rawMessage, contentType);
  if (!media) {
    return null;
  }

  const cachedFile = await ensureCachedTelegramFile({
    api,
    cacheDir,
    media,
    ...(signal == null ? {} : { signal }),
  });
  if (!cachedFile) {
    return null;
  }

  const dataUrl = await toDataUrl(cachedFile.path, cachedFile.mimeType, signal);
  return {
    type: "image_url",
    image_url: {
      url: dataUrl,
    },
    ...(media.emoji ? { emoji: media.emoji } : {}),
  };
}
