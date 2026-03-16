import { describe, expect, it } from "vitest";
import { assembleBranchAwareContext } from "./context-window.js";
import type { TaskContextMessage } from "./types.js";

function createMessage(
  id: number,
  telegramMessageId: number,
  createdAt: number,
  overrides: Partial<TaskContextMessage> = {}
): TaskContextMessage {
  return {
    id,
    role: "user",
    chatType: "group",
    chatTitle: "Test",
    contentType: "text",
    textContent: `m${telegramMessageId}`,
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

describe("assembleBranchAwareContext", () => {
  it("includes downstream timeline when replying to an older message", () => {
    const messages: TaskContextMessage[] = [
      createMessage(1, 101, 1),
      createMessage(2, 102, 2, {
        parentMessageId: 1,
      }),
      createMessage(3, 103, 3, {
        parentMessageId: 2,
      }),
      createMessage(4, 104, 4, {
        parentMessageId: 3,
      }),
      createMessage(5, 105, 5, {
        replyToTelegramMessageId: 102,
        parentMessageId: 2,
        referenceMessageId: 2,
      }),
    ];

    const context = assembleBranchAwareContext({
      conversationMessages: messages,
      triggerTelegramMessageId: 105,
      limit: 10,
    });

    expect(context.map((message) => message.telegramMessageId)).toEqual([
      102,
      103,
      104,
      105,
    ]);
  });

  it("avoids mixing sibling branches when continuing one branch", () => {
    const messages: TaskContextMessage[] = [
      createMessage(1, 201, 1),
      createMessage(2, 202, 2, { parentMessageId: 1 }),
      createMessage(3, 203, 3, { parentMessageId: 2 }),
      createMessage(4, 204, 4, { parentMessageId: 3 }),
      createMessage(5, 205, 5, {
        replyToTelegramMessageId: 202,
        parentMessageId: 2,
        referenceMessageId: 2,
      }),
      createMessage(6, 206, 6, { parentMessageId: 5, referenceMessageId: 2 }),
      createMessage(7, 207, 7, { parentMessageId: 6, referenceMessageId: 2 }),
    ];

    const context = assembleBranchAwareContext({
      conversationMessages: messages,
      triggerTelegramMessageId: 207,
      anchorMessageId: 201,
      limit: 10,
    });

    expect(context.map((message) => message.telegramMessageId)).toEqual([
      201,
      202,
      205,
      206,
      207,
    ]);
  });

  it("keeps the anchor and recent branch window when trimming", () => {
    const messages: TaskContextMessage[] = [
      createMessage(1, 201, 1),
      createMessage(2, 202, 2, { parentMessageId: 1 }),
      createMessage(3, 203, 3, { parentMessageId: 2 }),
      createMessage(4, 204, 4, { parentMessageId: 3 }),
      createMessage(5, 205, 5, {
        replyToTelegramMessageId: 202,
        parentMessageId: 2,
        referenceMessageId: 2,
      }),
    ];

    const context = assembleBranchAwareContext({
      conversationMessages: messages,
      triggerTelegramMessageId: 205,
      anchorMessageId: 201,
      limit: 3,
    });

    expect(context.map((message) => message.telegramMessageId)).toEqual([
      201,
      204,
      205,
    ]);
  });
});
