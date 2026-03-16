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
  "- Answer the latest user request using only the context you were actually given.",
  "- Do not claim to have performed actions or retrieved content unless that result is present in the current system context.",
  "- If needed information is missing, say it is missing instead of making it up.",
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
