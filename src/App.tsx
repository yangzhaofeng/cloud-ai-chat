import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble, Conversations, Sender, XProvider } from '@ant-design/x';
import type { BubbleItemType, BubbleListProps, ConversationsProps } from '@ant-design/x';
import { PlusOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Layout } from 'antd';

type Role = 'user' | 'ai';

interface Message {
  id: string;
  role: Role;
  content: string;
}

interface Chat {
  id: string;
  title: string;
  updated_at: number;
}

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

// Parse the simplified backend SSE protocol: data: {"delta":"..."} / data: [DONE]
async function readSSE(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void) {
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
          const parsed = JSON.parse(payload) as { delta?: string };
          if (parsed.delta) onDelta(parsed.delta);
        } catch {
          /* ignore incomplete chunks */
        }
      }
    }
  }
}

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string>(uid);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
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
          body: JSON.stringify({ chatId, message: text }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          throw new Error(`请求失败 (${res.status}) ${detail}`);
        }
        await readSSE(res.body, (delta) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === aiMsg.id ? { ...m, content: m.content + delta } : m)),
          );
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          const msg = (err as Error).message || '网络错误';
          setMessages((prev) =>
            prev.map((m) => (m.id === aiMsg.id && !m.content ? { ...m, content: `⚠️ ${msg}` } : m)),
          );
        }
      } finally {
        setLoading(false);
        abortRef.current = null;
        void loadChats(); // Refresh titles / ordering.
      }
    },
    [activeId, loading, loadChats],
  );

  const convItems: ConversationsProps['items'] = chats.map((c) => ({ key: c.id, label: c.title }));

  const bubbleItems: BubbleItemType[] = messages.map((m, i) => {
    const isStreamingAi = loading && m.role === 'ai' && i === messages.length - 1;
    return {
      key: m.id,
      role: m.role,
      content: m.content,
      // Show loading until the first token arrives, then let Bubble handle the streaming typewriter effect.
      loading: isStreamingAi && !m.content,
      streaming: isStreamingAi && !!m.content,
    };
  });

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
