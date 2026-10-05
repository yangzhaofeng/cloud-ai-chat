import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble, Conversations, Sender, XProvider } from '@ant-design/x';
import type { BubbleItemType, BubbleListProps, ConversationsProps } from '@ant-design/x';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  Button,
  Collapse,
  Input,
  InputNumber,
  Layout,
  Modal,
  Popover,
  Segmented,
  Slider,
  Switch,
  Typography,
} from 'antd';

type Role = 'user' | 'ai';
type ReasoningEffort = 'low' | 'high' | 'max';

interface Message {
  id: string;
  role: Role;
  content: string;
  reasoning?: string; // thinking chain; streamed live and persisted per message
}

interface Chat {
  id: string;
  title: string;
  updated_at: number;
}

interface ChatSettings {
  systemPrompt: string;
  contextTokens: number;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  topP: number;
}

// Suggested system prompt; new chats start with it. Clearing the field is allowed
// and means the request is sent with no system message at all.
const DEFAULT_SYSTEM_PROMPT = '你是一个乐于助人的 AI 助手，回答尽量简洁、准确。';

const DEFAULT_SETTINGS: ChatSettings = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  contextTokens: 4000,
  thinking: false,
  reasoningEffort: 'low',
  temperature: 1,
  topP: 1,
};

const uid = () => crypto.randomUUID();

// Bubble.List role styles (note: in v2 the prop is the singular `role`).
const roleConfig: BubbleListProps['role'] = {
  ai: {
    placement: 'start',
    avatar: <Avatar icon={<RobotOutlined />} style={{ background: '#1677ff' }} />,
  },
  user: {
    placement: 'end',
    avatar: <Avatar icon={<UserOutlined />} style={{ background: '#52c41a' }} />,
  },
};

// Parse the simplified backend SSE protocol:
//   data: {"delta":"..."}     answer token
//   data: {"reasoning":"..."} thinking-chain token
//   data: [DONE]
async function readSSE(
  body: ReadableStream<Uint8Array>,
  handlers: { onDelta: (delta: string) => void; onReasoning: (reasoning: string) => void },
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as { delta?: string; reasoning?: string };
          if (parsed.reasoning) handlers.onReasoning(parsed.reasoning);
          if (parsed.delta) handlers.onDelta(parsed.delta);
        } catch {
          /* ignore incomplete chunks */
        }
      }
    }
  }
}

// Thinking chain shown above the answer. Collapsed once the answer starts.
function ReasoningPanel({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Collapse
      ghost
      size="small"
      defaultActiveKey={streaming ? ['reasoning'] : undefined}
      style={{ maxWidth: 680, background: '#fafafa', borderRadius: 8 }}
      items={[
        {
          key: 'reasoning',
          label: (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {streaming ? '正在思考…' : '深度思考'}
            </Typography.Text>
          ),
          children: (
            <div
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                lineHeight: 1.7,
                color: '#8c8c8c',
                maxHeight: 260,
                overflow: 'auto',
              }}
            >
              {text}
            </div>
          ),
        },
      ]}
    />
  );
}

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string>(uid);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [collapsed, setCollapsed] = useState(false);
  // id of the message currently open in the inline editor, if any.
  const [editingId, setEditingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirror of activeId for async callbacks, plus a sequence number so a stale
  // post-send refresh can never clobber a newer turn.
  const activeIdRef = useRef(activeId);
  const streamSeq = useRef(0);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) return;
      const data = (await res.json()) as { chats?: Chat[] };
      setChats(data.chats ?? []);
    } catch {
      /* ignore network errors */
    }
  }, []);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  // Load per-chat settings + history messages when switching chats.
  useEffect(() => {
    let alive = true;
    setMessages([]);
    (async () => {
      try {
        const res = await fetch(`/api/chats/${activeId}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          settings?: Partial<ChatSettings> | null;
          messages?: Array<{
            id: number;
            role: string;
            content: string;
            reasoning?: string | null;
          }>;
        };
        if (!alive) return;
        // A chat that has never been configured returns null -> use defaults.
        setSettings({ ...DEFAULT_SETTINGS, ...(data.settings ?? {}) });
        setMessages(
          (data.messages ?? []).map((m) => ({
            id: String(m.id),
            role: m.role === 'user' ? 'user' : 'ai',
            content: m.content,
            reasoning: m.reasoning ?? undefined,
          })),
        );
      } catch {
        /* a new chat has no history, which is expected */
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeId]);

  // Keep the ref in sync so late async work knows which chat is on screen, and
  // drop any in-progress inline edit when the chat changes.
  useEffect(() => {
    activeIdRef.current = activeId;
    setEditingId(null);
  }, [activeId]);

  // Re-read a chat's messages from the server. Used after a stream so the UI
  // picks up the real row ids, which editing / regenerating needs.
  const syncMessages = useCallback(async (chatId: string, seq: number) => {
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages?: Array<{ id: number; role: string; content: string; reasoning?: string | null }>;
      };
      // Ignore if the user switched chats or started another turn meanwhile.
      if (activeIdRef.current !== chatId || streamSeq.current !== seq) return;
      setMessages(
        (data.messages ?? []).map((m) => ({
          id: String(m.id),
          role: m.role === 'user' ? 'user' : 'ai',
          content: m.content,
          reasoning: m.reasoning ?? undefined,
        })),
      );
    } catch {
      /* keep whatever is on screen */
    }
  }, []);

  const onNew = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setEditingId(null);
    setSettings(DEFAULT_SETTINGS);
    setActiveId(uid());
  }, []);

  const onSelect = useCallback((key: string) => {
    abortRef.current?.abort();
    setActiveId(key);
  }, []);

  const onStop = useCallback(() => abortRef.current?.abort(), []);

  // Shared streaming path for a fresh message and for an edited one. When
  // `editMessageId` is set, that earlier question is rewritten and everything
  // after it is discarded so the reply is regenerated from that turn.
  const runStream = useCallback(
    async ({
      chatId,
      text,
      editMessageId,
    }: {
      chatId: string;
      text: string;
      editMessageId?: number;
    }) => {
      if (loading) return;

      const aiMsg: Message = { id: uid(), role: 'ai', content: '' };
      if (editMessageId !== undefined) {
        // Truncate locally to the edited turn, then append the fresh reply bubble.
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === String(editMessageId));
          const head = idx >= 0 ? prev.slice(0, idx + 1) : prev;
          const edited = head.map((m) =>
            m.id === String(editMessageId) ? { ...m, content: text, reasoning: undefined } : m,
          );
          return [...edited, aiMsg];
        });
      } else {
        const userMsg: Message = { id: uid(), role: 'user', content: text };
        setMessages((prev) => [...prev, userMsg, aiMsg]);
      }

      setInput('');
      setEditingId(null);
      setLoading(true);

      const seq = ++streamSeq.current;
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            message: text,
            ...(editMessageId !== undefined ? { editMessageId } : {}),
            systemPrompt: settings.systemPrompt,
            contextTokens: settings.contextTokens,
            temperature: settings.temperature,
            top_p: settings.topP,
            thinking: settings.thinking,
            reasoning_effort: settings.reasoningEffort,
          }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          throw new Error(`请求失败 (${res.status}) ${detail}`);
        }
        await readSSE(res.body, {
          onDelta: (delta) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === aiMsg.id ? { ...m, content: m.content + delta } : m)),
            );
          },
          onReasoning: (reasoning) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aiMsg.id ? { ...m, reasoning: (m.reasoning ?? '') + reasoning } : m,
              ),
            );
          },
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          const msg = (err as Error).message || '网络错误';
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiMsg.id && !m.content ? { ...m, content: `⚠️ ${msg}` } : m,
            ),
          );
        }
      } finally {
        setLoading(false);
        abortRef.current = null;
        void loadChats(); // Refresh titles / ordering.
        void syncMessages(chatId, seq); // Pick up real row ids so editing works.
      }
    },
    [loading, loadChats, settings, syncMessages],
  );

  const onSend = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text) void runStream({ chatId: activeId, text });
    },
    [activeId, runStream],
  );

  // Confirm an inline edit: rewrite that question and regenerate from it onward.
  const onEditQuestion = useCallback(
    (messageId: string, text: string) => {
      const id = Number(messageId);
      if (text && Number.isInteger(id)) {
        void runStream({ chatId: activeId, text, editMessageId: id });
      }
    },
    [activeId, runStream],
  );

  // Re-answer the most recent question as-is.
  const onRegenerate = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    const id = Number(lastUser.id);
    if (Number.isInteger(id)) {
      void runStream({ chatId: activeId, text: lastUser.content, editMessageId: id });
    }
  }, [activeId, messages, runStream]);

  // Fork a chat: copy its settings and history into a new chat, then open it.
  const onDuplicate = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chats/${id}/duplicate`, { method: 'POST' });
        if (!res.ok) return;
        const data = (await res.json()) as { id?: string };
        await loadChats();
        if (data.id) setActiveId(data.id);
      } catch {
        /* ignore */
      }
    },
    [loadChats],
  );

  // Delete a chat and its history. If it was the open chat, start a blank one.
  const onDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chats/${id}/delete`, { method: 'POST' });
        if (!res.ok && res.status !== 404) return;
        await loadChats();
        if (id === activeIdRef.current) onNew();
      } catch {
        /* ignore */
      }
    },
    [loadChats, onNew],
  );

  const convItems: ConversationsProps['items'] = chats.map((c) => ({ key: c.id, label: c.title }));

  // Per-conversation action menu: fork or delete a chat.
  const convMenu: ConversationsProps['menu'] = (chat) => {
    const title = chats.find((c) => c.id === chat.key)?.title ?? '该对话';
    return {
      items: [
        { key: 'duplicate', label: '复制对话', icon: <CopyOutlined /> },
        { key: 'delete', label: '删除对话', icon: <DeleteOutlined />, danger: true },
      ],
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        if (key === 'duplicate') {
          void onDuplicate(chat.key);
        } else if (key === 'delete') {
          Modal.confirm({
            title: '删除对话',
            content: `确定删除「${title}」及其全部消息吗？此操作不可撤销。`,
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () => onDelete(chat.key),
          });
        }
      },
    };
  };

  const bubbleItems: BubbleItemType[] = messages.map((m, i) => {
    const isStreamingAi = loading && m.role === 'ai' && i === messages.length - 1;
    const isLast = i === messages.length - 1;
    // Only messages persisted with a numeric row id can be edited / regenerated.
    const canEdit = m.role === 'user' && Number.isInteger(Number(m.id));
    const canRegenerate = m.role === 'ai' && isLast && Number.isInteger(Number(m.id));
    return {
      key: m.id,
      role: m.role,
      content: m.content,
      // The thinking chain sits above the answer; keep `content` a string so the
      // Bubble typewriter effect still applies to the answer itself.
      header: m.reasoning ? (
        <ReasoningPanel text={m.reasoning} streaming={isStreamingAi && !m.content} />
      ) : undefined,
      // Show loading only before the first token; once reasoning arrives the
      // panel itself signals progress.
      loading: isStreamingAi && !m.content && !m.reasoning,
      streaming: isStreamingAi && !!m.content,
      // Questions are editable inline; confirming rewrites the turn and regenerates.
      editable: canEdit
        ? { editing: editingId === m.id, okText: '保存并重新生成', cancelText: '取消' }
        : false,
      onEditConfirm: canEdit ? (content: string) => onEditQuestion(m.id, content.trim()) : undefined,
      onEditCancel: canEdit ? () => setEditingId(null) : undefined,
      footer:
        !loading && canEdit && editingId !== m.id ? (
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => setEditingId(m.id)}
          >
            编辑
          </Button>
        ) : !loading && canRegenerate ? (
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRegenerate}>
            重新生成
          </Button>
        ) : undefined,
    };
  });

  const settingsContent = (
    <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Typography.Text strong>System Prompt</Typography.Text>
        <Input.TextArea
          value={settings.systemPrompt}
          onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
          placeholder="（留空则不发送 system prompt）"
          autoSize={{ minRows: 2, maxRows: 6 }}
          style={{ fontSize: 12 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            留空则不发送 system prompt
          </Typography.Text>
          {settings.systemPrompt.trim() !== DEFAULT_SYSTEM_PROMPT && (
            <Typography.Link
              style={{ fontSize: 11 }}
              onClick={() => setSettings((s) => ({ ...s, systemPrompt: DEFAULT_SYSTEM_PROMPT }))}
            >
              恢复默认
            </Typography.Link>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text strong>深度思考</Typography.Text>
        <Switch
          checked={settings.thinking}
          onChange={(v) => setSettings((s) => ({ ...s, thinking: v }))}
        />
      </div>
      {settings.thinking && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Typography.Text strong>思考强度</Typography.Text>
          <Segmented
            block
            options={['low', 'high', 'max']}
            value={settings.reasoningEffort}
            onChange={(v) =>
              setSettings((s) => ({ ...s, reasoningEffort: v as ReasoningEffort }))
            }
          />
        </div>
      )}
      <div>
        <Typography.Text strong>Temperature: {settings.temperature.toFixed(1)}</Typography.Text>
        <Slider
          min={0}
          max={2}
          step={0.1}
          value={settings.temperature}
          onChange={(v) => setSettings((s) => ({ ...s, temperature: v }))}
        />
      </div>
      <div>
        <Typography.Text strong>Top P: {settings.topP.toFixed(2)}</Typography.Text>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={settings.topP}
          onChange={(v) => setSettings((s) => ({ ...s, topP: v }))}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Typography.Text strong>上下文上限</Typography.Text>
        <InputNumber
          min={1000}
          max={1000000}
          step={1000}
          value={settings.contextTokens}
          onChange={(v) => setSettings((s) => ({ ...s, contextTokens: v ?? 1000 }))}
          addonAfter="tokens"
          style={{ width: '100%' }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          按估算 token 裁剪历史，超出时从最早的对话开始丢弃
        </Typography.Text>
      </div>
    </div>
  );

  return (
    <XProvider>
      <Layout style={{ height: '100vh' }}>
        <Layout.Sider
          theme="light"
          width={280}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          collapsedWidth={0}
          trigger={null}
          style={{
            display: 'flex',
            flexDirection: 'column',
            padding: collapsed ? 0 : 12,
            borderInlineEnd: collapsed ? 'none' : '1px solid #f0f0f0',
            overflow: 'auto',
          }}
        >
          <Conversations
            items={convItems}
            activeKey={activeId}
            onActiveChange={(key) => onSelect(String(key))}
            menu={convMenu}
            creation={{
              icon: <PlusOutlined />,
              label: '新建对话',
              onClick: onNew,
            }}
          />
        </Layout.Sider>

        <Layout.Content style={{ display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Bubble.List
              autoScroll
              role={roleConfig}
              items={bubbleItems}
              style={{ maxWidth: 860, margin: '0 auto' }}
            />
          </div>

          <div style={{ maxWidth: 860, width: '100%', margin: '0 auto' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Button
                  type="text"
                  size="small"
                  aria-label={collapsed ? '展开对话列表' : '收起对话列表'}
                  icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={() => setCollapsed((c) => !c)}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {settings.thinking ? `深度思考 · ${settings.reasoningEffort}` : '深度思考已关闭'}
                  {' · '}temp {settings.temperature.toFixed(1)}
                  {' · '}top_p {settings.topP.toFixed(2)}
                  {' · '}ctx {settings.contextTokens}
                  {settings.systemPrompt.trim() ? '' : ' · 无 system prompt'}
                </Typography.Text>
              </div>
              <Popover
                trigger="click"
                placement="topRight"
                title="生成参数"
                content={settingsContent}
              >
                <Button size="small" icon={<SettingOutlined />}>
                  参数
                </Button>
              </Popover>
            </div>
            <Sender
              value={input}
              onChange={(v) => setInput(v)}
              onSubmit={onSend}
              onCancel={onStop}
              loading={loading}
              placeholder="输入消息，Enter 发送 / Shift + Enter 换行"
              autoSize={{ minRows: 1, maxRows: 6 }}
            />
          </div>
        </Layout.Content>
      </Layout>
    </XProvider>
  );
}
