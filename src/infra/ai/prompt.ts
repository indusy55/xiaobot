import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CHAT_ROLE_PROMPT_PATH = join(
  process.cwd(),
  "prompts",
  "chat-role.md"
);
const CHAT_STYLE_PROMPT_PATH = join(
  process.cwd(),
  "prompts",
  "chat-style.md"
);
const CHAT_DECISION_PROMPT_PATH = join(
  process.cwd(),
  "prompts",
  "chat-decision.md"
);
const CHAT_CAPABILITY_DECISION_PROMPT_PATH = join(
  process.cwd(),
  "prompts",
  "chat-capability-decision.md"
);

let cachedPrompt: string | null = null;
let cachedDecisionPrompt: string | null = null;
let cachedCapabilityDecisionPrompt: string | null = null;

export async function readChatPrompt() {
  if (cachedPrompt != null) {
    return cachedPrompt;
  }

  const [rolePrompt, stylePrompt] = await Promise.all([
    readFile(CHAT_ROLE_PROMPT_PATH, "utf8"),
    readFile(CHAT_STYLE_PROMPT_PATH, "utf8"),
  ]);

  cachedPrompt = [rolePrompt.trim(), stylePrompt.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");

  return cachedPrompt;
}

export async function readChatDecisionPrompt() {
  if (cachedDecisionPrompt != null) {
    return cachedDecisionPrompt;
  }

  cachedDecisionPrompt = (await readFile(CHAT_DECISION_PROMPT_PATH, "utf8")).trim();
  return cachedDecisionPrompt;
}

export async function readChatCapabilityDecisionPrompt() {
  if (cachedCapabilityDecisionPrompt != null) {
    return cachedCapabilityDecisionPrompt;
  }

  cachedCapabilityDecisionPrompt = (
    await readFile(CHAT_CAPABILITY_DECISION_PROMPT_PATH, "utf8")
  ).trim();
  return cachedCapabilityDecisionPrompt;
}
