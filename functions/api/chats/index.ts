// GET /api/chats -- chat list for <Conversations>
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at
       FROM chats
      ORDER BY updated_at DESC
      LIMIT 200`,
  ).all();

  return new Response(JSON.stringify({ chats: results }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
