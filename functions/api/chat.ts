// POST /api/chat
//   1. Persist the user question to D1 (or, when `editMessageId` is set, rewrite
//      that earlier question and drop everything after it so the reply is
//      regenerated from that point).
//   2. Call an OpenAI-compatible upstream API with stream: true.
//   3. Convert the upstream SSE into a simplified protocol: `data: {"delta":"..."}` / `data: [DONE]`.
//   4. Use waitUntil() to asynchronously persist the full assistant reply to D1 after the stream ends.

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const DEFAULT_CONTEXT_TOKENS = 4000; // Default budget for the conversation sent upstream.
const MAX_CONTEXT_TOKENS = 1_000_000; // Upper bound accepted from the client.
const MAX_HISTORY_MESSAGES = 1000; // Hard cap on rows fetched before token trimming.

type ReasoningEffort = 'low' | 'high' | 'max';

interface ChatBody {
  chatId?: string;
  message?: string;
  // When set, `message` replaces this earlier user message, every message after
  // it is deleted, and a fresh reply is generated from it.
  editMessageId?: number;
  systemPrompt?: string;
  contextTokens?: number;
  temperature?: number;
  top_p?: number;
  thinking?: boolean;
  reasoning_effort?: ReasoningEffort;
}

// Canonical per-chat settings, persisted as JSON on the chats row.
interface ChatSettings {
  systemPrompt: string;
  contextTokens: number;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  topP: number;
}

// Normalize the request body into canonical settings, applying the same clamps
// used for the upstream call so what we store matches what we send.
function readSettings(body: ChatBody): ChatSettings {
  return {
    systemPrompt: body.systemPrompt?.trim() ?? '',
    contextTokens:
      typeof body.contextTokens === 'number' && Number.isFinite(body.contextTokens)
        ? clamp(body.contextTokens, 256, MAX_CONTEXT_TOKENS)
        : DEFAULT_CONTEXT_TOKENS,
    thinking: body.thinking === true,
    reasoningEffort: body.reasoning_effort ?? 'low',
    temperature:
      typeof body.temperature === 'number' && Number.isFinite(body.temperature)
        ? clamp(body.temperature, 0, 2)
        : 1,
    topP:
      typeof body.top_p === 'number' && Number.isFinite(body.top_p)
        ? clamp(body.top_p, 0, 1)
        : 1,
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const chatId = body.chatId?.trim();
  const message = body.message?.trim();
  if (!chatId || !message) {
    return json({ error: 'chatId and message are required' }, 400);
  }
  if (!env.AI_BASE_URL || !env.AI_API_KEY || !env.AI_MODEL) {
    return json({ error: 'AI_BASE_URL / AI_API_KEY / AI_MODEL not configured' }, 500);
  }

  const now = Date.now();
  const settings = readSettings(body);
  const editMessageId = readEditId(body);

  // Ensure the chat exists and persist the current settings on every send
  // (overwrite on conflict). The title is only set on first insert, so it is
  // not rewritten on subsequent messages.
  const upsertChat = env.DB.prepare(
    `INSERT INTO chats (id, title, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
  ).bind(chatId, makeTitle(message), JSON.stringify(settings), now, now);

  if (editMessageId !== null) {
    // 1a. Editing an earlier question: rewrite it in place and drop everything
    //     after it, so the answer is regenerated from this turn onward.
    const target = await env.DB.prepare(
      `SELECT role FROM messages WHERE id = ? AND chat_id = ?`,
    )
      .bind(editMessageId, chatId)
      .first<{ role: string }>();
    if (!target || target.role !== 'user') {
      return json({ error: 'editMessageId must reference a user message in this chat' }, 400);
    }

    const firstUser = await env.DB.prepare(
      `SELECT MIN(id) AS minId FROM messages WHERE chat_id = ? AND role = 'user'`,
    )
      .bind(chatId)
      .first<{ minId: number | null }>();

    const statements = [
      env.DB.prepare(`UPDATE messages SET content = ? WHERE id = ?`).bind(message, editMessageId),
      env.DB.prepare(`DELETE FROM messages WHERE chat_id = ? AND id > ?`).bind(
        chatId,
        editMessageId,
      ),
    ];
    // Editing the opening question also refreshes the derived title.
    if (firstUser?.minId === editMessageId) {
      statements.push(
        env.DB.prepare(`UPDATE chats SET title = ? WHERE id = ?`).bind(makeTitle(message), chatId),
      );
    }
    statements.push(upsertChat);
    await env.DB.batch(statements);
  } else {
    // 1b. New message: create the chat on the first message (title = first 30
    //     chars) and append the user question.
    await env.DB.batch([
      upsertChat,
      env.DB.prepare(
        `INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)`,
      ).bind(chatId, message, now),
    ]);
  }

  // 3. Load recent context (including the user message just inserted). Fetch a
  //    generous window, then trim from the oldest side to fit the token budget.
  const { results } = await env.DB.prepare(
    `SELECT role, content FROM (
        SELECT id, role, content FROM messages
         WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  )
    .bind(chatId, MAX_HISTORY_MESSAGES)
    .all<{ role: string; content: string }>();

  const systemPrompt = settings.systemPrompt;
  const contextTokens = settings.contextTokens;

  // Keep the newest messages that fit the budget; always keep at least the latest.
  const history = results ?? [];
  const kept: Array<{ role: string; content: string }> = [];
  let used = systemPrompt ? estimateTokens(systemPrompt) : 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content);
    if (kept.length > 0 && used + cost > contextTokens) break;
    used += cost;
    kept.unshift(history[i]);
  }

  // An empty system prompt is intentional: send no system message at all.
  const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...kept] : kept;

  // Optional generation parameters forwarded to the upstream. Unknown fields are
  // ignored by most OpenAI-compatible servers, so only send what the client set.
  const upstreamBody: Record<string, unknown> = {
    model: env.AI_MODEL,
    messages,
    stream: true,
  };
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    upstreamBody.temperature = clamp(body.temperature, 0, 2);
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) {
    upstreamBody.top_p = clamp(body.top_p, 0, 1);
  }
  if (typeof body.thinking === 'boolean') {
    upstreamBody.thinking = { type: body.thinking ? 'enabled' : 'disabled' };
    // reasoning_effort is only meaningful when thinking is on.
    if (body.thinking && body.reasoning_effort) {
      upstreamBody.reasoning_effort = body.reasoning_effort;
    }
  }

  // 4. Call the upstream with stream: true.
  let upstream: Response;
  try {
    upstream = await fetch(`${env.AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    return json({ error: `upstream request failed: ${String(err)}` }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: 'upstream error', status: upstream.status, detail }, 502);
  }

  // 5. Forward the upstream SSE while accumulating the full reply.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let assistant = '';
  let reasoningText = '';
  let aborted = false;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      upstreamReader = reader;
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const sseData = trimmed.slice(5).trim();
            if (!sseData || sseData === '[DONE]') continue;

            let content = '';
            let reasoning = '';
            try {
              const delta = JSON.parse(sseData)?.choices?.[0]?.delta;
              content = delta?.content ?? '';
              // Providers disagree on the field name for the thinking chain.
              reasoning = delta?.reasoning_content ?? delta?.reasoning ?? '';
            } catch {
              continue; // skip keep-alive lines / incomplete chunks
            }

            // Accumulate the thinking chain so it can be persisted; also forward it live.
            if (reasoning) {
              reasoningText += reasoning;
              if (!aborted) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ reasoning })}\n\n`));
              }
            }

            if (content) {
              assistant += content;
              if (!aborted) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: content })}\n\n`));
              }
            }
          }
        }
      } catch (err) {
        if (!aborted) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
          );
        }
      } finally {
        if (!aborted) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
        // Persist in the background; do not block the response.
        waitUntil(persistAssistant(env, chatId, assistant, reasoningText, Date.now()));
      }
    },
    cancel() {
      aborted = true;
      // Cancel via the reader (the body is locked by getReader(); calling body.cancel() directly is a no-op).
      upstreamReader?.cancel().catch(() => {});
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// A valid `editMessageId` is a positive integer row id; anything else means "new message".
function readEditId(body: ChatBody): number | null {
  const id = body.editMessageId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

// Rough token estimate, tuned to DeepSeek's guidance: ~0.3 token per ASCII char,
// ~0.6 token per non-ASCII (CJK) char. Good enough for trimming context; not a
// real tokenizer, so other providers may differ somewhat.
const TOKENS_PER_ASCII = 0.3;
const TOKENS_PER_NON_ASCII = 0.6;

function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 0x7f ? TOKENS_PER_NON_ASCII : TOKENS_PER_ASCII;
  }
  return Math.ceil(tokens);
}

function makeTitle(message: string): string {
  const title = message.replace(/\s+/g, ' ').trim();
  return title.length > 30 ? `${title.slice(0, 30)}…` : title || '新对话';
}

async function persistAssistant(
  env: Env,
  chatId: string,
  content: string,
  reasoning: string,
  at: number,
) {
  if (!content && !reasoning) return;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (chat_id, role, content, reasoning, created_at)
         VALUES (?, 'assistant', ?, ?, ?)`,
      ).bind(chatId, content, reasoning || null, at),
      env.DB.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).bind(at, chatId),
    ]);
  } catch (err) {
    console.error('failed to persist assistant message', err);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
