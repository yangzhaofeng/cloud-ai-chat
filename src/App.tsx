import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble, Conversations, Sender, XProvider } from '@ant-design/x';
import type { BubbleItemType, BubbleListProps, ConversationsProps } from '@ant-design/x';
import {
  PlusOutlined,
  RobotOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  Button,
  Collapse,
  Input,
  Layout,
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
  reasoning?: string; // thinking chain; streamed live but not persisted
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

// Placeholder shown in the System Prompt field; the same text is the backend default.
const DEFAULT_SYSTEM_PROMPT = '你是一个乐于助人的 AI 助手，回答尽量简洁、准确。';

const DEFAULT_SETTINGS: ChatSettings = {
  systemPrompt: '',
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
  const abortRef = useRef<AbortController | null>(null);

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

  // Load history messages when switching chats.
  useEffect(() => {
    let alive = true;
    setMessages([]);
    (async () => {
      try {
        const res = await fetch(`/api/chats/${activeId}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages?: Array<{ id: number; role: string; content: string }>;
        };
        if (!alive) return;
        setMessages(
          (data.messages ?? []).map((m) => ({
            id: String(m.id),
            role: m.role === 'user' ? 'user' : 'ai',
            content: m.content,
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

  const onNew = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setActiveId(uid());
  }, []);

  const onSelect = useCallback((key: string) => {
    abortRef.current?.abort();
    setActiveId(key);
  }, []);

  const onStop = useCallback(() => abortRef.current?.abort(), []);

  const onSend = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || loading) return;

      const chatId = activeId;
      const userMsg: Message = { id: uid(), role: 'user', content: text };
      const aiMsg: Message = { id: uid(), role: 'ai', content: '' };

      setMessages((prev) => [...prev, userMsg, aiMsg]);
      setInput('');
      setLoading(true);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            message: text,
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
      }
    },
    [activeId, loading, loadChats, settings],
  );

  const convItems: ConversationsProps['items'] = chats.map((c) => ({ key: c.id, label: c.title }));

  const bubbleItems: BubbleItemType[] = messages.map((m, i) => {
    const isStreamingAi = loading && m.role === 'ai' && i === messages.length - 1;
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
    };
  });

  const settingsContent = (
    <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Typography.Text strong>System Prompt</Typography.Text>
        <Input.TextArea
          value={settings.systemPrompt}
          onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
          placeholder={DEFAULT_SYSTEM_PROMPT}
          autoSize={{ minRows: 2, maxRows: 6 }}
          style={{ fontSize: 12 }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          留空则使用默认提示词
        </Typography.Text>
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
      <div>
        <Typography.Text strong>上下文上限: {settings.contextTokens} tokens</Typography.Text>
        <Slider
          min={1000}
          max={32000}
          step={1000}
          value={settings.contextTokens}
          onChange={(v) => setSettings((s) => ({ ...s, contextTokens: v }))}
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
          style={{
            display: 'flex',
            flexDirection: 'column',
            padding: 12,
            borderInlineEnd: '1px solid #f0f0f0',
            overflow: 'auto',
          }}
        >
          <Conversations
            items={convItems}
            activeKey={activeId}
            onActiveChange={(key) => onSelect(String(key))}
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
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {settings.thinking ? `深度思考 · ${settings.reasoningEffort}` : '深度思考已关闭'}
                {' · '}temp {settings.temperature.toFixed(1)}
                {' · '}top_p {settings.topP.toFixed(2)}
                {' · '}ctx {settings.contextTokens}
                {settings.systemPrompt.trim() ? ' · 自定义提示词' : ''}
              </Typography.Text>
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
