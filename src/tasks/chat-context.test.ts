import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  buildChatModelMessages,
  collectReusableToolObservations,
  extractToolObservationsFromSnapshot,
  selectMediaMessageIdsForModelInput,
} from "./chat-context.js";
import type { TaskContextMessage } from "./types.js";

function createMessage(
  telegramMessageId: number,
  contentType: string,
  createdAt: number,
  overrides: Partial<TaskContextMessage> = {}
): TaskContextMessage {
  return {
    id: telegramMessageId,
    role: "user",
    chatType: "private",
    chatTitle: null,
    contentType,
    textContent: contentType === "sticker" ? "🙂" : null,
    rawMessage: "{}",
    replyToTelegramMessageId: null,
    fromId: "1",
    fromUsername: "alice",
    fromFirstName: "Alice",
    fromLastName: null,
    fromLanguageCode: "zh",
    telegramMessageId,
    parentMessageId: null,
    referenceMessageId: null,
    createdAt,
    ...overrides,
  };
}

describe("extractToolObservationsFromSnapshot", () => {
  it("extracts valid web search observations from snapshot payload", () => {
    const observations = extractToolObservationsFromSnapshot(
      JSON.stringify({
        toolObservations: [
          {
            type: "web_search",
            context: {
              query: "telegram bot api",
              answer: null,
              knowledge: null,
              results: [],
            },
          },
        ],
      })
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.type).toBe("web_search");
    expect(observations[0]?.source).toBe("snapshot");
  });
});

describe("collectReusableToolObservations", () => {
  it("keeps only recent completed snapshot observations", () => {
    const now = 1_000_000;
    const observations = collectReusableToolObservations(
      [
        {
          status: "failed",
          createdAt: now - 1_000,
          contextSnapshot: JSON.stringify({
            toolObservations: [
              {
                type: "web_search",
                context: {
                  query: "failed query",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
            ],
          }),
        },
        {
          status: "completed",
          createdAt: now - 20 * 60 * 1000,
          contextSnapshot: JSON.stringify({
            toolObservations: [
              {
                type: "web_search",
                context: {
                  query: "stale query",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
            ],
          }),
        },
        {
          status: "completed",
          createdAt: now - 2_000,
          contextSnapshot: JSON.stringify({
            toolObservations: [
              {
                type: "web_search",
                context: {
                  query: "fresh query",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
            ],
          }),
        },
      ],
      now
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.context?.query).toBe("fresh query");
  });

  it("deduplicates repeated recent queries and caps reuse count", () => {
    const now = 1_000_000;
    const observations = collectReusableToolObservations(
      [
        {
          status: "completed",
          createdAt: now - 1_000,
          contextSnapshot: JSON.stringify({
            toolObservations: [
              {
                type: "web_search",
                context: {
                  query: "query one",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
            ],
          }),
        },
        {
          status: "completed",
          createdAt: now - 2_000,
          contextSnapshot: JSON.stringify({
            toolObservations: [
              {
                type: "web_search",
                context: {
                  query: "query one",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
              {
                type: "web_search",
                context: {
                  query: "query two",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
            ],
          }),
        },
        {
          status: "completed",
          createdAt: now - 3_000,
          contextSnapshot: JSON.stringify({
            toolObservations: [
              {
                type: "web_search",
                context: {
                  query: "query three",
                  answer: null,
                  knowledge: null,
                  results: [],
                },
              },
            ],
          }),
        },
      ],
      now
    );

    expect(observations).toHaveLength(2);
    expect(observations.map((item) => item.context?.query)).toEqual([
      "query one",
      "query two",
    ]);
  });
});

describe("selectMediaMessageIdsForModelInput", () => {
  it("prioritizes trigger and replied media before older history", () => {
    const selected = selectMediaMessageIdsForModelInput({
      contextMessages: [
        createMessage(101, "photo", 1),
        createMessage(102, "text", 2),
        createMessage(103, "sticker", 3),
        createMessage(104, "photo", 4),
        createMessage(105, "photo", 5),
      ],
      triggerTelegramMessageId: 103,
      repliedTelegramMessageId: 101,
      maxMediaMessages: 3,
    });

    expect([...selected]).toEqual([103, 101, 105]);
  });

  it("falls back to the most recent media when trigger has no media", () => {
    const selected = selectMediaMessageIdsForModelInput({
      contextMessages: [
        createMessage(201, "photo", 1),
        createMessage(202, "photo", 2),
        createMessage(203, "text", 3),
        createMessage(204, "sticker", 4),
      ],
      triggerTelegramMessageId: 203,
      repliedTelegramMessageId: null,
      maxMediaMessages: 2,
    });

    expect([...selected]).toEqual([204, 202]);
  });

  it("allows disabling media embedding entirely", () => {
    const selected = selectMediaMessageIdsForModelInput({
      contextMessages: [createMessage(301, "photo", 1)],
      triggerTelegramMessageId: 301,
      repliedTelegramMessageId: null,
      maxMediaMessages: 0,
    });

    expect([...selected]).toEqual([]);
  });
});

describe("buildChatModelMessages", () => {
  it("keeps sticker-only assistant messages semantic instead of bare emoji", async () => {
    const messages = await buildChatModelMessages({
      dependencies: {
        api: {} as never,
        telegramMediaCacheDir: "data/media-cache",
        chatMediaContextLimit: 0,
      },
      contextMessages: [
        createMessage(401, "sticker", 1, {
          role: "assistant",
          textContent: "🙂",
          rawMessage: JSON.stringify({
            message: {
              sticker: {
                file_id: "sticker-1",
                file_unique_id: "unique-1",
                emoji: "🙂",
              },
            },
          }),
        }),
        createMessage(402, "text", 2, {
          textContent: "再发一个",
        }),
      ],
      signal: new AbortController().signal,
      triggerTelegramMessageId: 402,
      repliedTelegramMessageId: 401,
    });

    expect(messages[0]).toBeInstanceOf(AIMessage);
    expect(messages[0]?.content).toBe("Sticker 🙂.");
    expect(messages[1]).toBeInstanceOf(HumanMessage);
  });
});
