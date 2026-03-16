import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { PlaywrightWebBaseLoader } from "@langchain/community/document_loaders/web/playwright";
import { load as loadHtml } from "cheerio";
import { loadConfig } from "../../config/index.js";

export interface WebpageReadResult {
  url: string;
  title: string | null;
  description: string | null;
  content: string;
  excerpt: string;
  truncated: boolean;
  mode: "dynamic";
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function clipText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  if (/^10\./.test(normalized)) {
    return true;
  }

  if (/^192\.168\./.test(normalized)) {
    return true;
  }

  const classB = normalized.match(/^172\.(\d{1,3})\./);
  if (classB) {
    const segment = Number(classB[1]);
    if (segment >= 16 && segment <= 31) {
      return true;
    }
  }

  return false;
}

export function validateReadableWebpageUrl(rawUrl: string) {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  if (isPrivateHostname(url.hostname)) {
    throw new Error("Private or local URLs are not allowed.");
  }

  return url.toString();
}

async function renderDynamicHtml(url: string, timeoutMs: number) {
  const loader = new PlaywrightWebBaseLoader(url, {
    gotoOptions: {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    },
    async evaluate(page) {
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(
        () => undefined
      );
      return page.content();
    },
  });

  const [document] = await loader.load();
  return document?.pageContent ?? "";
}

function extractPageContent(html: string, url: string, maxChars: number) {
  const $ = loadHtml(html);

  $("script, style, noscript, iframe, svg, canvas").remove();
  const title = normalizeWhitespace($("title").first().text()) || null;
  const description =
    normalizeWhitespace(
      $('meta[name="description"]').attr("content") ??
        $('meta[property="og:description"]').attr("content") ??
        ""
    ) || null;

  const mainTextCandidates = [
    $("main").first().text(),
    $("article").first().text(),
    $('[role="main"]').first().text(),
    $("body").first().text(),
  ]
    .map((text) => normalizeWhitespace(text))
    .filter((text) => text.length > 0);

  const content = mainTextCandidates[0] ?? "";
  const truncated = content.length > maxChars;
  const finalContent = clipText(content, maxChars);

  return {
    url,
    title,
    description,
    content: finalContent,
    excerpt: clipText(finalContent, 400),
    truncated,
    mode: "dynamic" as const,
  };
}

export async function readWebpage(
  rawUrl: string,
  options?: { signal?: AbortSignal }
): Promise<WebpageReadResult> {
  const config = loadConfig();
  const url = validateReadableWebpageUrl(rawUrl);
  options?.signal?.throwIfAborted();
  const html = await renderDynamicHtml(url, config.WEBPAGE_READ_TIMEOUT_MS);
  options?.signal?.throwIfAborted();
  return extractPageContent(html, url, config.WEBPAGE_MAX_CONTENT_CHARS);
}

export async function canReadWebpageWithCheerio(rawUrl: string) {
  const config = loadConfig();
  const url = validateReadableWebpageUrl(rawUrl);
  const loader = new CheerioWebBaseLoader(url, {
    timeout: config.WEBPAGE_READ_TIMEOUT_MS,
    selector: "body",
  });
  const [doc] = await loader.load();
  return (doc?.pageContent?.trim().length ?? 0) > 0;
}

export function formatWebpageReadPrompt(context: WebpageReadResult) {
  const lines = [
    "Webpage content context (dynamic render):",
    `- URL: ${context.url}`,
    `- Mode: ${context.mode}`,
  ];

  if (context.title) {
    lines.push(`- Title: ${context.title}`);
  }

  if (context.description) {
    lines.push(`- Description: ${context.description}`);
  }

  lines.push(`- Truncated: ${context.truncated ? "yes" : "no"}`);
  lines.push("- Page content:");
  lines.push(context.content);
  lines.push(
    "- Use this only when it helps answer the latest user message, and say when the page content may be incomplete or outdated."
  );

  return lines.join("\n");
}
