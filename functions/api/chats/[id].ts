// GET /api/chats/:id -- per-chat settings + history messages for <Bubble.List>
export const onRequestGet: PagesFunction<Env, 'id'> = async ({ env, params }) => {
  const id = String(params.id);

  const chat = await env.DB.prepare(`SELECT settings FROM chats WHERE id = ?`)
    .bind(id)
    .first<{ settings: string | null }>();

  const { results } = await env.DB.prepare(
    `SELECT id, role, content, reasoning, created_at
       FROM messages
      WHERE chat_id = ?
      ORDER BY id ASC`,
  )
    .bind(id)
    .all();

  // A legacy or malformed blob must not break history loading: fall back to null,
  // which the client interprets as "use defaults".
  let settings: unknown = null;
  if (chat?.settings) {
    try {
      settings = JSON.parse(chat.settings);
    } catch {
      settings = null;
    }
  }

  return new Response(JSON.stringify({ settings, messages: results }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
