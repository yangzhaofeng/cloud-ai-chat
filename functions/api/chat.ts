// POST /api/chat
//   1. Persist the user question to D1.
//   2. Call an OpenAI-compatible upstream API with stream: true.
//   3. Convert the upstream SSE into a simplified protocol: `data: {"delta":"..."}` / `data: [DONE]`.
//   4. Use waitUntil() to asynchronously persist the full assistant reply to D1 after the stream ends.

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const SYSTEM_PROMPT = '你是一个乐于助人的 AI 助手，回答尽量简洁、准确。';
const HISTORY_LIMIT = 20; // Maximum number of history messages sent to the model.

interface ChatBody {
  chatId?: string;
  message?: string;
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

  // 1. Ensure the chat exists: create it on the first message, using the first 30 chars as the title.
  await env.DB.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
    .bind(chatId, makeTitle(message), now, now)
    .run();

  // 2. Persist the user question.
  await env.DB.prepare(
    `INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)`,
  )
    .bind(chatId, message, now)
    .run();

  // 3. Load recent context (including the user message just inserted).
  const { results } = await env.DB.prepare(
    `SELECT role, content FROM (
        SELECT id, role, content FROM messages
         WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  )
    .bind(chatId, HISTORY_LIMIT)
    .all<{ role: string; content: string }>();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...(results ?? [])];

  // 4. Call the upstream with stream: true.
  let upstream: Response;
  try {
    upstream = await fetch(`${env.AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({ model: env.AI_MODEL, messages, stream: true }),
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
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let delta = '';
            try {
              delta = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? '';
            } catch {
              continue; // skip keep-alive lines / incomplete chunks
            }
            if (!delta) continue;

            assistant += delta;
            if (!aborted) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
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
        waitUntil(persistAssistant(env, chatId, assistant, Date.now()));
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

function makeTitle(message: string): string {
  const title = message.replace(/\s+/g, ' ').trim();
  return title.length > 30 ? `${title.slice(0, 30)}…` : title || '新对话';
}

async function persistAssistant(env: Env, chatId: string, content: string, at: number) {
  if (!content) return;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)`,
      ).bind(chatId, content, at),
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
