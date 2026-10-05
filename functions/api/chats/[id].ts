// GET /api/chats/:id -- history messages of a chat for <Bubble.List>
export const onRequestGet: PagesFunction<Env, 'id'> = async ({ env, params }) => {
  const id = String(params.id);

  const { results } = await env.DB.prepare(
    `SELECT id, role, content, created_at
       FROM messages
      WHERE chat_id = ?
      ORDER BY id ASC`,
  )
    .bind(id)
    .all();

  return new Response(JSON.stringify({ messages: results }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
