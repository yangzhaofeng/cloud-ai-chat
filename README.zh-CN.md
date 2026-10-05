# cloud-ai-chat

基于 **Cloudflare Pages + D1 + @ant-design/x** 的极简个人 AI 聊天室。

- 前端：Vite + React 19 + antd 6 + `@ant-design/x`（`Conversations` / `Bubble.List` / `Sender`）
- 后端：Cloudflare Pages Functions（`/functions/api/`）
- 存储：Cloudflare D1（SQLite）
- 模型：任意兼容 OpenAI `/chat/completions` 的服务（默认 DeepSeek），`stream: true` 流式返回

## 三个接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chats` | 会话列表（供 `<Conversations>`） |
| GET | `/api/chats/:id` | 某会话的历史消息（供 `<Bubble.List>`） |
| POST | `/api/chat` | 入参 `{ chatId, message }`；落库用户问题 → 流式调用上游 → 用 `waitUntil()` 在流结束后异步落库完整回复 |

## 快速开始

```bash
npm install

# 1. 建 D1 数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create cloud-ai-chat

# 2. 初始化表结构（本地）
npm run db:init

# 3. 配置密钥：复制 .dev.vars.example 为 .dev.vars 并填入 AI_API_KEY
cp .dev.vars.example .dev.vars

# 4. 构建并本地运行（wrangler 同时提供前端与 Functions）
npm run build
npm run cf:dev      # 打开 http://localhost:8788
```

前端单独开发（热更新）时：

```bash
npm run dev         # http://localhost:5173，/api 代理到 8788
```

## 部署到 Cloudflare

需要一个已开通 Pages 与 D1 的 Cloudflare 账号。有两种部署方式：**Wrangler 命令行**（最快，和 `npm` 脚本对应）或 **Cloudflare 控制台** <https://dash.cloudflare.com>（连接 Git，无需本地工具）。二选一即可。

两种方式都需要先准备好：D1 数据库、表结构、`AI_API_KEY` 密钥。

### 方式 A —— Wrangler 命令行

`wrangler` 已是开发依赖，直接用 `npx wrangler ...` 即可。

#### A1. 登录

```bash
npx wrangler login   # 打开浏览器完成授权
npx wrangler whoami  # 确认当前账号
```

#### A2. 创建 D1 数据库

```bash
npx wrangler d1 create cloud-ai-chat
```

把返回的 `database_id` 填进 `wrangler.toml`，替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cloud-ai-chat"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

> `database_name` 要和上面创建时一致；`binding = "DB"` 就是 Functions 里 `env.DB` 读到的绑定名。

#### A3. 在线上库建表

```bash
npm run db:init:remote
```

该命令会对线上 D1 执行 `schema.sql`（可重复执行）。

#### A4. 配置线上密钥

`AI_API_KEY` 必须作为 secret，不能写进 `[vars]`：

```bash
npx wrangler pages secret put AI_API_KEY --project-name cloud-ai-chat
# 按提示粘贴密钥
```

非敏感变量（`AI_BASE_URL`、`AI_MODEL`）来自 `wrangler.toml` 的 `[vars]`，会随代码一起上传。

#### A5. 构建并发布

```bash
npm run deploy
```

`npm run deploy` = `npm run build && wrangler pages deploy dist`。首次运行会创建 Pages 项目（按提示命名为 `cloud-ai-chat`，或加上 `--project-name cloud-ai-chat`）。`dist/` 里的前端和 `functions/` 里的 Functions 会一起上传，`wrangler.toml` 中的 D1 绑定会自动应用到项目。

完成后 wrangler 会打印线上地址（`https://cloud-ai-chat.pages.dev`）。以后每次发版重新执行 `npm run deploy` 即可。

### 方式 B —— Cloudflare 控制台（dash.cloudflare.com）

无需本地 Wrangler，由 Cloudflare 从 Git 仓库构建。

#### B1. 创建 D1 数据库

1. 打开 <https://dash.cloudflare.com> → **Workers & Pages** → 左侧 **D1 SQL Database** → **Create**。
2. 命名为 `cloud-ai-chat` 并创建。
3. 进入该数据库，复制 **Database ID** —— 第 B4 步绑定到 Pages 项目时会用到（也可以填进 `wrangler.toml`，保持本地 CLI 一致）。

#### B2. 初始化表结构

仍在 D1 数据库页面，打开 **Console** 标签，粘贴 `schema.sql` 的内容，点击 **Execute**（执行一次即可）。

#### B3. 从 Git 创建 Pages 项目

1. 把仓库推到 GitHub/GitLab。
2. 控制台 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选择仓库。
3. 构建设置：
   - **Framework preset**：`None`（或 `Vite`）
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
4. **Save and Deploy**。首次构建会创建项目并生成 `*.pages.dev` 地址。

#### B4. 绑定 D1 数据库

项目 → **Settings → Functions → D1 database bindings → Add binding**：

- **Variable name**：`DB`
- **D1 database**：`cloud-ai-chat`

#### B5. 配置环境变量与密钥

项目 → **Settings → Environment variables**（至少加到 **Production**，需要的话 **Preview** 也加上）：

- `AI_BASE_URL` —— 例如 `https://api.deepseek.com`（不带 `/chat/completions`）
- `AI_MODEL` —— 例如 `deepseek-flash`
- `AI_API_KEY` —— 点击 **Encrypt** 存为密钥，而不是明文

#### B6. 重新部署

Deployments → **Retry deployment**（或推送新提交）使绑定和变量生效。站点地址为 `https://<项目名>.pages.dev`。

### 验证部署

- 打开 `*.pages.dev` 地址发一条消息；能流式返回即说明上游密钥与流式链路正常。
- 控制台 → 项目 → **Settings → Functions** 应能看到 `DB` 的 D1 绑定。
- 控制台 → **D1 → cloud-ai-chat → Console** → `SELECT * FROM chats;`，发消息后应能看到会话（每轮对话都会写入）。

## 环境变量

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| `AI_BASE_URL` | `wrangler.toml [vars]` / 控制台环境变量 | 上游地址，结尾不要带 `/chat/completions` |
| `AI_MODEL` | `wrangler.toml [vars]` / 控制台环境变量 | 模型名 |
| `AI_API_KEY` | 本地 `.dev.vars` / 控制台**加密**密钥 | **不要**写进 `wrangler.toml` |
| `DB` | `wrangler.toml` / 控制台 D1 绑定 | D1 数据库 |

## 目录结构

```
functions/
  types.d.ts              # 全局 Env 类型
  api/chat.ts             # POST /api/chat
  api/chats/index.ts      # GET  /api/chats
  api/chats/[id].ts       # GET  /api/chats/:id
src/App.tsx               # 单文件页面：左侧会话列表 + 右侧气泡流 + 输入框
schema.sql                # D1 表结构
wrangler.toml             # Pages / D1 / vars 配置
```
