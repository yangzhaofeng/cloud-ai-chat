// POST /api/chats/:id/duplicate -- fork a chat by copying its settings and full
// message history into a brand new chat.
export const onRequestPost: PagesFunction<Env, 'id'> = async ({ env, params }) => {
  const sourceId = String(params.id);

  const source = await env.DB.prepare(`SELECT id, title, settings FROM chats WHERE id = ?`)
    .bind(sourceId)
    .first<{ id: string; title: string; settings: string | null }>();

  if (!source) {
    return json({ error: 'chat not found' }, 404);
  }

  const newId = crypto.randomUUID();
  const now = Date.now();
  const title = `${source.title} (副本)`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO chats (id, title, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(newId, title, source.settings, now, now),
    // Copy every message in order; SQLite assigns fresh AUTOINCREMENT ids in the
    // order they are inserted, so the fork keeps the original chronology.
    env.DB.prepare(
      `INSERT INTO messages (chat_id, role, content, reasoning, created_at)
       SELECT ?, role, content, reasoning, created_at
         FROM messages
        WHERE chat_id = ?
        ORDER BY id ASC`,
    ).bind(newId, sourceId),
  ]);

  return json({ id: newId, title }, 201);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
