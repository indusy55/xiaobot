import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  buildTelegramActionPlanMessages,
  parseTelegramActionPlanResponse,
} from "./chat-plan.js";

describe("buildTelegramActionPlanMessages", () => {
  it("embeds the context packet json for planner input", () => {
    const messages = buildTelegramActionPlanMessages({
      systemPrompt: "role and style",
      runtimeContextPrompt: "runtime",
      inputEnvelopePrompt: "input envelope",
      packet: {
        meta: {
          platform: "telegram",
          chatRef: "chat_main",
          conversationRef: "conversation_active",
          triggerRef: "message_1",
          repliedRef: null,
          nowIso: new Date(Date.UTC(2026, 2, 16, 10, 0, 0)).toISOString(),
          schemaVersion: 1,
        },
        runtime: {
          chatType: "group",
          threadRef: null,
          botUserRef: null,
          capabilities: {
            canSendMessage: true,
            canSendSticker: true,
            canReply: true,
            canQuote: true,
            canEnqueueTask: true,
            canCancelTask: true,
          },
          limits: {
            maxMessageLength: 4096,
            maxOperations: 4,
            maxReplyDepth: 20,
          },
        },
        refs: {
          chat_main: {
            kind: "chat",
            telegramChatId: "chat-1",
            title: "Bot Test",
          },
          conversation_active: {
            kind: "conversation",
            conversationId: "chat:chat-1",
            scope: "chat",
          },
          message_1: {
            kind: "message",
            telegramMessageId: 1,
            role: "user",
            authorRef: null,
            chatRef: "chat_main",
            threadRef: null,
            conversationRef: "conversation_active",
            replyToRef: null,
            parentRef: null,
            branchRootRef: null,
            createdAtIso: new Date(Date.UTC(2026, 2, 16, 10, 0, 0)).toISOString(),
            content: [{ type: "text", text: "hi" }],
            quote: null,
          },
        },
        windows: {
          conversation: ["message_1"],
          recentChat: ["message_1"],
          backlog: [],
          candidateReplyTargets: ["message_1"],
          candidateAnchors: ["message_1"],
          availableStickers: [],
          reusableToolResults: [],
        },
      },
    });

    expect(messages.at(-1)?.content).toContain('"chatRef": "chat_main"');
    expect(messages.at(-1)?.content).toContain('"candidateReplyTargets"');
  });
});

describe("parseTelegramActionPlanResponse", () => {
  it("normalizes loose planner output into a valid action plan", () => {
    const parsed = parseTelegramActionPlanResponse(
      new AIMessage(`{
        "disposition": "respond",
        "conversation": {
          "mode": "fork"
        },
        "operations": [
          {
            "type": "reply",
            "reply_to_ref": "message_1",
            "text": "好的",
            "parse_mode": "MarkdownV2"
          },
          {
            "type": "sticker",
            "reply_to_ref": "message_1",
            "sticker_ref": "sticker_1"
          },
          {
            "type": "cancel",
            "scope": "latest_in_chat"
          }
        ],
        "used_refs": ["message_1", "sticker_1"],
        "notes": {
          "summary": "reply with sticker",
          "reasoning_brief": "user asked for it"
        }
      }`)
    );

    expect(parsed.conversation.mode).toBe("fork_from_message");
    expect(parsed.operations.map((operation) => operation.type)).toEqual([
      "send_message",
      "send_sticker",
      "cancel_task",
    ]);
    expect(parsed.operations[0]?.opId).toBe("op_message_1");
  });
});
