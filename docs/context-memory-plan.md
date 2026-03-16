# Context Compression And Memory Recall Plan

## Purpose

This document defines a practical plan for adding context compression and memory recall to the bot.

It is written for two audiences:

- human review: so the project owner can quickly understand the design and tradeoffs
- implementation guidance: so future work can follow one clear plan instead of ad hoc changes

## Current State

The project already has several strong foundations:

- strict chat scoping by `chatId`, optional `threadId`, and `conversationId`
- anchored conversations for reply-based branching
- persisted inbound and outbound messages
- a task worker for non-blocking execution
- a unified AI input envelope
- backlog summary support for older messages inside the current conversation window

Relevant current code:

- `src/tasks/chat-task.ts`
- `src/tasks/base.ts`
- `src/infra/ai/input-envelope.ts`
- `src/infra/ai/conversation-summary.ts`
- `src/bot/conversation.ts`
- `src/bot/conversation-store.ts`

## Problem

The bot still has two medium-term weaknesses:

1. long conversations eventually lose fidelity even with a larger recent window
2. the bot has no durable memory model for important facts such as:
   - user preferences
   - project conventions
   - persistent identities or relationships in a group
   - unfinished work and agreed decisions

If we only keep increasing raw context size, cost and latency rise while quality becomes noisy.

## Goals

The design should:

- preserve strict scope boundaries and avoid cross-chat leakage
- improve long conversation continuity
- allow selective long-term recall of important facts
- keep the system understandable and debuggable
- fit the current SQLite-first architecture
- avoid jumping too early into a heavy vector-only design

## Non-Goals

This phase should not:

- embed every message in the database
- build a full agent memory platform
- introduce opaque recall that is hard to trace
- weaken the current conversation scoping rules

## Recommended Architecture

Use a three-layer context model.

### Layer 1: Working Context

This is the short-term context used on every turn.

It includes:

- latest user request
- recent conversation messages
- runtime context
- external context such as search and webpage reads

This already exists and should remain the first layer.

### Layer 2: Conversation Summary

This is compressed memory for one conversation thread.

It answers:

- what has this conversation already established
- what has been decided
- what is still open

This layer is scoped to `conversationId`, with `chatId` and optional `threadId` for safety.

### Layer 3: Long-Term Memory Recall

This stores durable atomic facts rather than raw transcript chunks.

It answers:

- what should the bot remember later
- what stable facts are useful across turns

Examples:

- user likes concise replies
- group project uses pnpm
- user prefers Chinese explanations but English error messages
- open task: migrate database before deployment

This layer must always be scope-filtered before recall.

## Why This Is A Better Fit Than Full Message Embeddings First

For this project, a summary-plus-memory approach is better than embedding all messages immediately.

Reasons:

- the bot already has strong structural scope boundaries
- full-message vector recall is noisy in group chats
- durable memory should be explicit and auditable
- SQLite is already a good fit for structured memory and simple retrieval
- embeddings can still be added later on top of curated memory items

## Data Model

Add two new tables.

### `conversation_summaries`

Purpose:

- store rolling summaries for one scoped conversation

Suggested fields:

- `id`
- `conversationId`
- `chatId`
- `threadId`
- `summaryText`
- `summaryVersion`
- `sourceMessageCount`
- `lastMessageCreatedAt`
- `createdAt`
- `updatedAt`

Notes:

- one active row per conversation is enough to start
- `summaryVersion` helps future prompt/schema migrations

### `memory_items`

Purpose:

- store atomic durable facts worth recalling later

Suggested fields:

- `id`
- `chatId`
- `threadId`
- `conversationId`
- `userId`
- `scopeType`
- `memoryType`
- `content`
- `keywords`
- `salience`
- `sourceTelegramMessageId`
- `sourceConversationId`
- `status`
- `expiresAt`
- `lastUsedAt`
- `createdAt`
- `updatedAt`

Recommended enums:

- `scopeType`: `chat | thread | conversation | user`
- `memoryType`: `preference | profile | relationship | project_fact | decision | pending_task | constraint | style`
- `status`: `active | archived | expired`

## Scope Rules

Scope safety is the highest priority.

Recall order should be:

1. current `conversationId`
2. current `threadId` inside the same `chatId`
3. current `chatId`
4. optional `userId` within the same `chatId`

Never recall across unrelated chats.

Private chats and group chats must stay isolated even if the same `userId` appears in both.

## Summary Strategy

Do not rebuild a full summary from all messages on every turn.

Use rolling summary updates.

### Strategy

- keep one current summary per conversation
- track the last summarized message timestamp or count
- after enough new messages accumulate, summarize only the delta
- merge old summary plus new message delta into a refreshed summary

### Trigger Conditions

Suggested initial triggers:

- after every completed assistant response, if new messages since last summary >= `N`
- or if raw conversation length exceeds `CHAT_CONTEXT_LIMIT`

Suggested initial config:

- `CHAT_SUMMARY_TRIGGER_MESSAGE_COUNT=12`
- `CHAT_SUMMARY_MAX_CHARS=2000`

### Summary Content

Each summary should capture:

- main topic
- confirmed facts
- unresolved questions
- decisions made
- active tasks or next steps
- user preferences discovered in this conversation

## Memory Extraction Strategy

Do not store every fact automatically.

Instead, run a conservative memory extraction step after a response is generated.

### Extraction Input

Use:

- latest user request
- assistant final reply
- recent conversation context
- existing conversation summary if available

### Extraction Output

Return structured memory candidates such as:

- whether a memory should be stored
- memory scope
- memory type
- memory content
- keywords
- salience
- expiration recommendation

### Extraction Rules

Store only when the fact is:

- likely useful later
- reasonably stable
- not overly sensitive unless intentionally needed
- scoped safely

Do not store:

- transient small talk
- one-off factual queries
- volatile external facts like prices unless explicitly marked as a pending task

## Recall Strategy

Recall should happen before final response generation.

### Retrieval Pipeline

1. determine recall scope from current task
2. query candidate memory items using scope filters
3. rank by:
   - exact scope match
   - salience
   - recency
   - keyword overlap
4. return a very small top set, for example `3-8` items
5. inject them into the AI input envelope as `MEMORY_RECALL`

### First Implementation Recommendation

Start with structured retrieval only:

- scope filtering in SQL
- keyword matching with plain text
- salience and recency ranking in code

Do not add embeddings yet.

### Future Upgrade

If retrieval quality later becomes insufficient:

- add embeddings only for `memory_items`
- never start by embedding all raw messages
- still perform strict scope filtering before vector ranking

## Integration With Current Chat Flow

Recommended future flow inside `ChatTask`:

1. load recent working context
2. load conversation summary if it exists
3. recall memory items for the current scope
4. run capability decision
5. run search and webpage reads if needed
6. build final AI input envelope with:
   - latest request
   - runtime context
   - conversation summary
   - memory recall
   - external context
   - response plan
7. generate final response
8. asynchronously update:
   - conversation summary
   - memory items

## Envelope Changes

Extend the current input envelope with two more sections:

- `CONVERSATION_SUMMARY`
- `MEMORY_RECALL`

Suggested precedence:

1. `LATEST_REQUEST`
2. `RUNTIME_CONTEXT`
3. `CONVERSATION_SUMMARY`
4. `MEMORY_RECALL`
5. `EXTERNAL_CONTEXT`
6. `RESPONSE_PLAN`

The prompt should explicitly say:

- latest request is primary
- summary is compressed background
- memory recall contains durable facts only
- recalled memory may be irrelevant if weakly matched

## Implementation Plan

### Phase 1: Conversation Summary Foundation

Deliverables:

- new `conversation_summaries` table
- repository/helpers for load and upsert
- summary prompt and summarizer output schema
- async summary updater after task completion
- envelope support for `CONVERSATION_SUMMARY`

Success criteria:

- long conversations keep topic continuity better
- no cross-scope leakage
- summary generation is idempotent and cheap enough

### Phase 2: Structured Memory Storage

Deliverables:

- new `memory_items` table
- memory extraction prompt and schema
- post-response extraction pipeline
- conservative persistence rules

Success criteria:

- only meaningful durable facts are stored
- stored memory is inspectable and understandable

### Phase 3: Memory Recall

Deliverables:

- scoped recall query
- ranking logic
- envelope support for `MEMORY_RECALL`
- config for recall limits

Success criteria:

- memory helps continuity without obvious noise
- group chat recall stays safely scoped

### Phase 4: Retrieval Quality Upgrade

Optional later phase.

Deliverables:

- keyword normalization or FTS
- optional embeddings for `memory_items`
- better ranking and de-duplication

Success criteria:

- improved recall quality without sacrificing safety

## Suggested Config Additions

Later phases will likely need:

- `CHAT_SUMMARY_TRIGGER_MESSAGE_COUNT`
- `CHAT_SUMMARY_MAX_CHARS`
- `CHAT_MEMORY_RECALL_LIMIT`
- `CHAT_MEMORY_EXTRACTION_ENABLED`
- `CHAT_MEMORY_MIN_SALIENCE`

These should be added only when the relevant phase begins.

## Testing Plan

### Unit Tests

- summary builder and summary merge logic
- scope filtering for memory queries
- ranking logic for recalled memories
- extraction sanitization
- envelope formatting with summary and memory sections

### Integration Tests

- private chat memory never appears in a group chat
- thread-scoped memory does not leak across threads
- long conversation still answers correctly after summary rollover
- recall can bring back a durable user preference

### Regression Tests

- reply target remains within current conversation
- summary and memory do not override latest request
- old summary does not resurrect expired facts

## Operational Guidance

For debugging, each response task should be able to record:

- which summary version was used
- which memory item ids were recalled
- why they were recalled

This should go into task context snapshots where practical.

## Final Recommendation

Implement this in order:

1. conversation summaries
2. structured memory extraction
3. structured scoped recall
4. optional embeddings for memory items only

This keeps the design aligned with the current project:

- simple enough to maintain
- safe enough for multi-chat use
- powerful enough to improve continuity meaningfully

## Status

This document is a design and execution plan.

It is not fully implemented yet.

The next implementation step should be Phase 1: `conversation_summaries`.
