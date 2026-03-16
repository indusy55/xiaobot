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

let cachedPrompt: string | null = null;

const CHAT_RESPONSE_SYSTEM_GUIDANCE = [
  "Response rules:",
  "- Answer the latest user request with the context you were actually given.",
  "- Use provided runtime context, search context, webpage context, and media context honestly.",
  "- Do not pretend you read a webpage, opened a link, searched the web, or inspected media unless the current system context actually includes that result.",
  "- If such content was not retrieved yet, say it was not retrieved yet instead of claiming it is impossible in principle.",
  "- Do not make up facts that are missing from the provided context.",
].join("\n");

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
    .concat(CHAT_RESPONSE_SYSTEM_GUIDANCE)
    .join("\n\n");

  return cachedPrompt;
}
