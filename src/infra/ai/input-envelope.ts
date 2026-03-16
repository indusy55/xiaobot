interface BuildChatInputEnvelopeOptions {
  latestRequest: {
    normalizedInput: string | null;
    speaker: string | null;
    triggerMessageId: number | null;
    contentType: string | null;
  };
  runtimeContext: string;
  backlogSummary?: string | null;
  responsePlan: string;
  toolContext?: string | null;
}

function buildSection(title: string, body: string | null | undefined) {
  const normalized = body?.trim();
  if (!normalized) {
    return null;
  }

  return [`[${title}]`, normalized].join("\n");
}

export function buildChatInputEnvelope(options: BuildChatInputEnvelopeOptions) {
  const latestRequestLines = ["- Prioritize answering this latest request."];

  if (options.latestRequest.speaker) {
    latestRequestLines.unshift(`- Speaker: ${options.latestRequest.speaker}`);
  }

  if (options.latestRequest.triggerMessageId != null) {
    latestRequestLines.push(
      `- Trigger message id: ${options.latestRequest.triggerMessageId}`
    );
  }

  if (options.latestRequest.contentType) {
    latestRequestLines.push(`- Content type: ${options.latestRequest.contentType}`);
  }

  if (options.latestRequest.normalizedInput) {
    latestRequestLines.push(
      `- Normalized input: ${options.latestRequest.normalizedInput}`
    );
  }

  const sections = [
    buildSection("LATEST_REQUEST", latestRequestLines.join("\n")),
    buildSection("RUNTIME_CONTEXT", options.runtimeContext),
    buildSection("CONVERSATION_BACKLOG", options.backlogSummary),
    buildSection("TOOL_CONTEXT", options.toolContext),
    buildSection("RESPONSE_PLAN", options.responsePlan),
  ].filter((section): section is string => section != null);

  sections.push(
    [
      "[INPUT_RULES]",
      "- Treat LATEST_REQUEST as the primary thing to answer.",
      "- Use RUNTIME_CONTEXT and prior messages only as supporting context.",
      "- Use CONVERSATION_BACKLOG only as compressed older context.",
      "- Use TOOL_CONTEXT only when it materially helps.",
      "- Follow RESPONSE_PLAN for who to address and how to reply.",
    ].join("\n")
  );

  return ["AI input envelope:", ...sections].join("\n\n");
}
