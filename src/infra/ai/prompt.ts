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
const CHAT_SEARCH_DECISION_PROMPT_PATH = join(
  process.cwd(),
  "prompts",
  "chat-search-decision.md"
);
const CHAT_WEBPAGE_DECISION_PROMPT_PATH = join(
  process.cwd(),
  "prompts",
  "chat-webpage-decision.md"
);

let cachedPrompt: string | null = null;
let cachedDecisionPrompt: string | null = null;
let cachedSearchDecisionPrompt: string | null = null;
let cachedWebpageDecisionPrompt: string | null = null;

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

export async function readChatSearchDecisionPrompt() {
  if (cachedSearchDecisionPrompt != null) {
    return cachedSearchDecisionPrompt;
  }

  cachedSearchDecisionPrompt = (
    await readFile(CHAT_SEARCH_DECISION_PROMPT_PATH, "utf8")
  ).trim();
  return cachedSearchDecisionPrompt;
}

export async function readChatWebpageDecisionPrompt() {
  if (cachedWebpageDecisionPrompt != null) {
    return cachedWebpageDecisionPrompt;
  }

  cachedWebpageDecisionPrompt = (
    await readFile(CHAT_WEBPAGE_DECISION_PROMPT_PATH, "utf8")
  ).trim();
  return cachedWebpageDecisionPrompt;
}
