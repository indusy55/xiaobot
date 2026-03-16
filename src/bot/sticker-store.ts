import { asc, eq } from "drizzle-orm";
import type { AppApi } from "./types.js";
import { db } from "../db/index.js";
import { stickerSetsTable, stickersTable } from "../db/schema.js";

type TelegramStickerSet = Awaited<ReturnType<AppApi["getStickerSet"]>>;
type TelegramSticker = TelegramStickerSet["stickers"][number];

export interface StickerCatalogEntry {
  id: number;
  setName: string;
  setTitle: string;
  fileId: string;
  fileUniqueId: string;
  emoji: string | null;
  isAnimated: boolean;
  isVideo: boolean;
}

function toStickerRecord(sticker: TelegramSticker, setName: string, now: number) {
  return {
    setName,
    fileId: sticker.file_id,
    fileUniqueId: sticker.file_unique_id,
    emoji: sticker.emoji ?? null,
    width: sticker.width,
    height: sticker.height,
    isAnimated: sticker.is_animated,
    isVideo: sticker.is_video,
    createdAt: now,
    updatedAt: now,
  };
}

export async function upsertStickerSet(options: {
  set: TelegramStickerSet;
  createdByUserId?: string;
}) {
  const { set, createdByUserId } = options;
  const now = Date.now();

  await db.transaction(async (tx) => {
    await tx
      .insert(stickerSetsTable)
      .values({
        name: set.name,
        title: set.title,
        stickerType: set.sticker_type,
        ...(createdByUserId == null ? {} : { createdByUserId }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: stickerSetsTable.name,
        set: {
          title: set.title,
          stickerType: set.sticker_type,
          ...(createdByUserId == null ? {} : { createdByUserId }),
          updatedAt: now,
        },
      });

    await tx.delete(stickersTable).where(eq(stickersTable.setName, set.name));

    if (set.stickers.length > 0) {
      await tx.insert(stickersTable).values(
        set.stickers.map((sticker) => toStickerRecord(sticker, set.name, now))
      );
    }
  });

  return {
    setName: set.name,
    title: set.title,
    stickerCount: set.stickers.length,
  };
}

export async function listStickerCatalog(limit = 40): Promise<StickerCatalogEntry[]> {
  const rows = await db
    .select({
      id: stickersTable.id,
      setName: stickersTable.setName,
      setTitle: stickerSetsTable.title,
      fileId: stickersTable.fileId,
      fileUniqueId: stickersTable.fileUniqueId,
      emoji: stickersTable.emoji,
      isAnimated: stickersTable.isAnimated,
      isVideo: stickersTable.isVideo,
    })
    .from(stickersTable)
    .innerJoin(stickerSetsTable, eq(stickersTable.setName, stickerSetsTable.name))
    .orderBy(asc(stickersTable.setName), asc(stickersTable.id))
    .limit(limit);

  return rows;
}

export async function findStickerByUniqueId(fileUniqueId: string) {
  const [row] = await db
    .select({
      id: stickersTable.id,
      setName: stickersTable.setName,
      setTitle: stickerSetsTable.title,
      fileId: stickersTable.fileId,
      fileUniqueId: stickersTable.fileUniqueId,
      emoji: stickersTable.emoji,
      isAnimated: stickersTable.isAnimated,
      isVideo: stickersTable.isVideo,
    })
    .from(stickersTable)
    .innerJoin(stickerSetsTable, eq(stickersTable.setName, stickerSetsTable.name))
    .where(eq(stickersTable.fileUniqueId, fileUniqueId))
    .limit(1);

  return row ?? null;
}
