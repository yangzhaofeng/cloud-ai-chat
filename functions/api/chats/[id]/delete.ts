// POST /api/chats/:id/delete -- delete a chat and all of its messages.
export const onRequestPost: PagesFunction<Env, 'id'> = async ({ env, params }) => {
  const id = String(params.id);

  const existing = await env.DB.prepare(`SELECT id FROM chats WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();

  if (!existing) {
    return json({ error: 'chat not found' }, 404);
  }

  // Delete the messages first so this also works where FK cascades are disabled.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages WHERE chat_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM chats WHERE id = ?`).bind(id),
  ]);

  return json({ ok: true, id });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
