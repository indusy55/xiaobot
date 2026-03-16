import { loadConfig } from "../../config/index.js";

interface SearchResultRecord {
  title: string;
  link: string | null;
  snippet: string | null;
  source: string | null;
}

export interface WebSearchContext {
  query: string;
  answer: string | null;
  knowledge: string | null;
  results: SearchResultRecord[];
}

type JsonRecord = Record<string, unknown>;

const EXPLICIT_SEARCH_PREFIXES = [
  /^google\s*[:：]?\s*/i,
  /^search\s*[:：]?\s*/i,
  /^搜(?:一下)?\s*/i,
  /^搜索\s*/i,
  /^查(?:一下|查)?\s*/i,
  /^帮我(?:搜|查)(?:一下)?\s*/i,
  /^谷歌(?:一下)?\s*/i,
] as const;

const SEARCH_HINT_PATTERN =
  /(最新|今天|今日|目前|现在|当前|实时|新闻|价格|股价|汇率|天气|比分|热搜|官网|文档|release|latest|today|current|news|price|weather|score|stock|docs?)/i;

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : null;
}

function compactText(parts: Array<string | null>) {
  return parts
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join(" - ");
}

function clipText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function parseCommaSeparatedList(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function buildSearxngSearchUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname =
    normalizedPath.endsWith("/search") || normalizedPath === "/search"
      ? normalizedPath || "/search"
      : `${normalizedPath}/search`;
  return url;
}

export function normalizeSearchQuery(input: string) {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  for (const pattern of EXPLICIT_SEARCH_PREFIXES) {
    if (!pattern.test(trimmed)) {
      continue;
    }

    const stripped = trimmed.replace(pattern, "").trim();
    return stripped.length > 0 ? clipText(stripped, 256) : null;
  }

  if (SEARCH_HINT_PATTERN.test(trimmed)) {
    return clipText(trimmed, 256);
  }

  return null;
}

function pickAnswerText(response: JsonRecord) {
  const answers = Array.isArray(response.answers) ? response.answers : [];
  for (const answer of answers) {
    const text = getString(answer);
    if (text.length > 0) {
      return clipText(text, 280);
    }
  }

  return null;
}

function pickKnowledgeText(response: JsonRecord) {
  const infoboxes = Array.isArray(response.infoboxes) ? response.infoboxes : [];

  for (const infobox of infoboxes) {
    const record = asRecord(infobox);
    if (!record) {
      continue;
    }

    const attributes = Array.isArray(record.attributes) ? record.attributes : [];
    const firstAttribute = attributes
      .map((item) => asRecord(item))
      .find((item) => item != null);
    const knowledge = compactText([
      getString(record.infobox),
      getString(record.content),
      getString(firstAttribute?.value),
    ]);

    if (knowledge.length > 0) {
      return clipText(knowledge, 280);
    }
  }

  return null;
}

function normalizeResults(response: JsonRecord, maxResults: number) {
  const results = Array.isArray(response.results) ? response.results : [];

  return results
    .map((item) => asRecord(item))
    .filter((item): item is JsonRecord => item != null)
    .map((item) => {
      const engines = Array.isArray(item.engines)
        ? item.engines
            .map((engine) => getString(engine))
            .filter((engine) => engine.length > 0)
        : [];

      return {
        title: clipText(getString(item.title) || "Untitled result", 160),
        link: getString(item.url) || getString(item.link) || null,
        snippet:
          clipText(
            getString(item.content) || getString(item.snippet),
            280
          ) || null,
        source:
          engines[0] ??
          getString(item.engine) ??
          getString(item.category) ??
          null,
      };
    })
    .slice(0, maxResults);
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `SearXNG request failed with ${response.status}: ${clipText(text, 200)}`
    );
  }

  return JSON.parse(text) as JsonRecord;
}

export async function searchWeb(
  query: string,
  options?: { signal?: AbortSignal }
) {
  const config = loadConfig();
  if (!config.SEARXNG_BASE_URL) {
    return null;
  }

  const requestUrl = buildSearxngSearchUrl(config.SEARXNG_BASE_URL);
  requestUrl.searchParams.set("q", query);
  requestUrl.searchParams.set("format", "json");
  requestUrl.searchParams.set("language", config.SEARXNG_LANGUAGE);
  requestUrl.searchParams.set(
    "safesearch",
    String(config.SEARXNG_SAFE_SEARCH)
  );

  const categories = parseCommaSeparatedList(config.SEARXNG_CATEGORIES);
  if (categories.length > 0) {
    requestUrl.searchParams.set("categories", categories.join(","));
  }

  const engines = parseCommaSeparatedList(config.SEARXNG_ENGINES);
  if (engines.length > 0) {
    requestUrl.searchParams.set("engines", engines.join(","));
  }

  const response = await fetch(requestUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    signal:
      options?.signal ??
      AbortSignal.timeout(config.WEB_SEARCH_TIMEOUT_MS),
  });
  const json = await readJsonResponse(response);

  return {
    query,
    answer: pickAnswerText(json),
    knowledge: pickKnowledgeText(json),
    results: normalizeResults(json, config.WEB_SEARCH_RESULT_LIMIT),
  } satisfies WebSearchContext;
}

export function formatWebSearchPrompt(context: WebSearchContext) {
  const lines = [
    "Fresh web search context (via SearXNG):",
    `- Query: ${context.query}`,
  ];

  if (context.answer) {
    lines.push(`- Quick answer: ${context.answer}`);
  }

  if (context.knowledge) {
    lines.push(`- Infobox: ${context.knowledge}`);
  }

  if (context.results.length > 0) {
    lines.push("- Top results:");
    lines.push(
      ...context.results.map((result, index) =>
        [
          `${index + 1}. ${result.title}${result.source ? ` (${result.source})` : ""}`,
          result.snippet,
          result.link,
        ]
          .filter((value): value is string => value != null && value.length > 0)
          .join("\n")
      )
    );
  } else {
    lines.push("- No search results were returned.");
  }

  lines.push(
    "- Use this only when it helps answer the latest user message, and say when the search results are inconclusive."
  );

  return lines.join("\n");
}
