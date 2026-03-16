import { describe, expect, it } from "vitest";
import {
  buildAnchoredConversationId,
  buildBranchConversationId,
  getAnchorConversationId,
  getAnchorMessageId,
  getBaseConversationId,
  getBranchRootMessageId,
  hasBranchRootConversationId,
  listConversationFamilyIds,
} from "./conversation.js";

describe("conversation id helpers", () => {
  it("builds and parses branch-aware conversation ids", () => {
    const conversationId = buildBranchConversationId("chat:1", 101, 205);

    expect(conversationId).toBe("chat:1:anchor:101:branch:205");
    expect(getBaseConversationId(conversationId)).toBe("chat:1");
    expect(getAnchorMessageId(conversationId)).toBe(101);
    expect(getBranchRootMessageId(conversationId)).toBe(205);
    expect(hasBranchRootConversationId(conversationId)).toBe(true);
  });

  it("keeps anchored conversations branchless when branch root equals anchor", () => {
    const conversationId = buildBranchConversationId("private:1", 301, 301);

    expect(conversationId).toBe(buildAnchoredConversationId("private:1", 301));
    expect(getAnchorMessageId(conversationId)).toBe(301);
    expect(getBranchRootMessageId(conversationId)).toBeNull();
    expect(hasBranchRootConversationId(conversationId)).toBe(false);
  });

  it("lists anchor-family ids for a branch conversation", () => {
    expect(
      listConversationFamilyIds("chat:1:anchor:101:branch:205")
    ).toEqual(["chat:1:anchor:101", "chat:1:anchor:101:branch:205"]);
    expect(getAnchorConversationId("chat:1:anchor:101:branch:205")).toBe(
      "chat:1:anchor:101"
    );
    expect(listConversationFamilyIds("private:1")).toEqual(["private:1"]);
  });
});
