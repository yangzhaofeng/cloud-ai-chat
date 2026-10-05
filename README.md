# cloud-ai-chat

A minimal personal AI chat app built on **Cloudflare Pages + D1 + @ant-design/x**.

- Frontend: Vite + React 19 + antd 6 + `@ant-design/x` (`Conversations` / `Bubble.List` / `Sender`)
- Backend: Cloudflare Pages Functions (`/functions/api/`)
- Storage: Cloudflare D1 (SQLite)
- Model: any OpenAI-compatible `/chat/completions` service (defaults to DeepSeek), streamed via `stream: true`

> 简体中文文档: [README.zh-CN.md](./README.zh-CN.md).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/chats` | Chat list (for `<Conversations>`) |
| GET | `/api/chats/:id` | A chat's settings + history messages (for `<Bubble.List>`) |
| POST | `/api/chat` | Body `{ chatId, message, ...settings }`; persists the user question, streams from the upstream, then persists the full assistant reply asynchronously via `waitUntil()` |
| POST | `/api/chats/:id/duplicate` | Fork a chat: copy its settings and full history into a new chat |
| POST | `/api/chats/:id/delete` | Delete a chat and all of its messages |

### Editing, forking and deleting

- **Empty system prompt** — `systemPrompt` may be left empty. When it is, the
  request is sent with *no* `system` message at all (the app no longer injects a
  built-in default; new chats simply start pre-filled with the suggested prompt).
- **Edit a question & regenerate** — passing `editMessageId` (a user message row
  id) to `POST /api/chat` rewrites that question in place, deletes every message
  after it in the same chat, and generates a fresh reply from that turn onward.
  In the UI each question bubble has an **编辑** action; confirming rewrites the
  turn (the last answer also has a **重新生成** action that repeats the same
  question).
- **Fork a chat** — the conversation list's per-item menu has **复制对话**, which
  calls `POST /api/chats/:id/duplicate` and opens the copy. The fork is a full
  independent snapshot (settings + every message, including reasoning chains).
- **Delete a chat** — the same menu has **删除对话**, which confirms and then
  calls `POST /api/chats/:id/delete` to remove the chat and all of its messages.
  If the deleted chat was open, the app switches to a blank new chat.

## Getting started

```bash
npm install

# 1. Create the D1 database and paste the returned database_id into wrangler.toml
npx wrangler d1 create cloud-ai-chat

# 2. Create the tables (local)
npm run db:init

# 3. Configure secrets: copy .dev.vars.example to .dev.vars and set AI_API_KEY
cp .dev.vars.example .dev.vars

# 4. Build and run locally (wrangler serves both the frontend and the Functions)
npm run build
npm run cf:dev      # open http://localhost:8788
```

Frontend-only development with HMR:

```bash
npm run dev         # http://localhost:5173, /api is proxied to 8788
```

## Deploy to Cloudflare

You need a Cloudflare account with Pages and D1 enabled. There are two ways to
deploy: the **Wrangler CLI** (fast, matches the `npm` scripts) or the
**Cloudflare dashboard** at <https://dash.cloudflare.com> (Git-connected, no
local tooling). Pick one.

Either way you first need a D1 database, its tables, and the `AI_API_KEY` secret.

### Cloudflare build settings

When you connect this repo in the Cloudflare dashboard (Create → Pages/Workers →
Connect to Git), fill the build configuration with:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler pages deploy dist` |
| Build output directory | `dist` |
| Root directory | *(leave default / repo root)* |

Notes:

- `npm run build` runs `npm run typecheck && vite build`, so TypeScript errors
  fail the build instead of shipping.
- On a **Pages** project with Git integration there is no separate *deploy
  command* field — Cloudflare uploads `dist/` plus the `functions/` directory
  itself. Use the deploy command above only where a deploy-command field exists
  (Workers Builds), or on the CLI.
- Locally, `npm run deploy` is just `npm run build && wrangler pages deploy dist`.

### Option A — Wrangler CLI

`wrangler` is already a dev dependency, so `npx wrangler ...` just works.

#### A1. Log in

```bash
npx wrangler login   # opens the browser and authorizes wrangler
npx wrangler whoami  # verify the active account
```

#### A2. Create the D1 database

```bash
npx wrangler d1 create cloud-ai-chat
```

Copy the returned `database_id` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`
in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "cloud-ai-chat"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

> Keep `database_name` matching the name above; `binding = "DB"` is what the
> Functions read via `env.DB`.

#### A3. Create the tables in the remote database

```bash
npm run db:init:remote
```

This runs `schema.sql` against the production D1 database (safe to re-run).

> **Upgrading a database created before per-chat settings existed?**
> `CREATE TABLE IF NOT EXISTS` does not add columns to tables that already
> exist, and the `ALTER TABLE` migration statements at the bottom of
> `schema.sql` are intentionally commented out to keep re-runs safe. Run them
> once against each existing database (local and remote) before deploying the
> new Functions:
>
> ```bash
> npx wrangler d1 execute cloud-ai-chat --remote --command "ALTER TABLE chats    ADD COLUMN settings  TEXT;"
> npx wrangler d1 execute cloud-ai-chat --remote --command "ALTER TABLE messages ADD COLUMN reasoning TEXT;"
> ```
>
> A fresh database (A3 / B2 below) already includes both columns.

#### A4. Set the production secret

`AI_API_KEY` must be a secret, never a plain `[vars]` value:

```bash
npx wrangler pages secret put AI_API_KEY --project-name cloud-ai-chat
# paste the key when prompted
```

The non-secret variables (`AI_BASE_URL`, `AI_MODEL`) come from `[vars]` in
`wrangler.toml` and are uploaded with the code on deploy.

#### A5. Build and deploy

```bash
npm run deploy
```

`npm run deploy` = `npm run build && wrangler pages deploy dist`. On the first
run it creates the Pages project (name it `cloud-ai-chat` when prompted, or pass
`--project-name cloud-ai-chat`). The frontend in `dist/` and the Functions in
`functions/` are uploaded together, and the D1 binding from `wrangler.toml` is
applied to the project automatically.

When it finishes, wrangler prints the live URL
(`https://cloud-ai-chat.pages.dev`). Re-run `npm run deploy` for every release.

### Option B — Cloudflare dashboard (dash.cloudflare.com)

No local Wrangler needed; Cloudflare builds from your Git repo.

#### B1. Create the D1 database

1. Go to <https://dash.cloudflare.com> → **Workers & Pages** → **D1 SQL Database**
   (left sidebar) → **Create**.
2. Name it `cloud-ai-chat` and create it.
3. Open the new database and copy its **Database ID** — you will bind it to the
   Pages project in step B4. (You can paste it into `wrangler.toml` too, so the
   local CLI stays consistent.)

#### B2. Apply the schema

Still on the D1 database page, open the **Console** tab and paste the contents of
`schema.sql`, then **Execute** (run it once).

#### B3. Create the Pages project from Git

1. Push this repository to GitHub/GitLab.
2. Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, and pick the repo.
3. Build settings (see [Cloudflare build settings](#cloudflare-build-settings)):
   - **Framework preset**: `None` (or `Vite`)
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. **Save and Deploy**. The first build creates the project and its
   `*.pages.dev` URL.

#### B4. Bind the D1 database

Project → **Settings → Functions → D1 database bindings → Add binding**:

- **Variable name**: `DB`
- **D1 database**: `cloud-ai-chat`

#### B5. Add the environment variables and secret

Project → **Settings → Environment variables** (add for **Production**, and
**Preview** if you want them there too):

- `AI_BASE_URL` — e.g. `https://api.deepseek.com` (no `/chat/completions`)
- `AI_MODEL` — e.g. `deepseek-flash`
- `AI_API_KEY` — click **Encrypt** so it is stored as a secret, not plaintext

#### B6. Redeploy

Deployments → **Retry deployment** (or push a new commit) so the binding and
variables take effect. The site is live at `https://<project>.pages.dev`.

### Verify the deployment

- Open the `*.pages.dev` URL and send a message; a streamed reply means the
  upstream key and streaming path work.
- Dashboard → your project → **Settings → Functions** should list the `DB` D1
  binding.
- Dashboard → **D1 → cloud-ai-chat → Console** → `SELECT * FROM chats;` should
  show your chat after you send a message (a write lands here for every turn).

## Environment variables

| Name | Location | Description |
| --- | --- | --- |
| `AI_BASE_URL` | `wrangler.toml [vars]` / dashboard env vars | Upstream base URL; do NOT append `/chat/completions` |
| `AI_MODEL` | `wrangler.toml [vars]` / dashboard env vars | Model name |
| `AI_API_KEY` | local `.dev.vars` / dashboard **encrypted** secret | Do **not** put it in `wrangler.toml` |
| `DB` | `wrangler.toml` / dashboard D1 binding | D1 database |

## Project layout

```
functions/
  types.d.ts                     # global Env type
  api/chat.ts                    # POST /api/chat (send / edit+regenerate)
  api/chats/index.ts             # GET  /api/chats
  api/chats/[id].ts              # GET  /api/chats/:id
  api/chats/[id]/duplicate.ts    # POST /api/chats/:id/duplicate (fork)
  api/chats/[id]/delete.ts       # POST /api/chats/:id/delete (delete)
src/App.tsx               # single-file page: chat list on the left, bubble stream + input on the right
schema.sql                # D1 schema
wrangler.toml             # Pages / D1 / vars config
```
