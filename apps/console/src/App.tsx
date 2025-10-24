import { useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_ASSISTANT_BASE_URL ?? 'http://localhost:4001';

type ConversationSummary = {
  id: string;
  leadId: string;
  status: string;
  intentScore: number;
  contactName: string;
  contactId: string | null;
  lastMessage: string;
  lastMessageAt: string;
  manualSuppressedUntil: string | null;
  journeyState: string | null;
  nextActionAt: string | null;
};

type Message = {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  createdAt: string;
};

type ConversationDetail = {
  conversation: {
    id: string;
    channel: string;
    leadId: string;
    status: string;
    intentScore: number;
    journey: {
      manualSuppressedUntil: string | null;
      state: string;
      nextActionAt: string | null;
    } | null;
    contacts: Array<{
      id: string;
      name: string | null;
      phone: string | null;
    }>;
  };
  messages: Message[];
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshConversations();
    const interval = window.setInterval(refreshConversations, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    void fetchJson<ConversationDetail>(`/api/conversations/${selectedId}`)
      .then((data) => {
        setDetail(data);
        setLoadingDetail(false);
      })
      .catch((err) => {
        console.error(err);
        setError('Failed to load conversation');
        setLoadingDetail(false);
      });
  }, [selectedId]);

  const isSuppressed = useMemo(() => {
    const until = detail?.conversation.journey?.manualSuppressedUntil;
    if (!until) return false;
    return new Date(until).getTime() > Date.now();
  }, [detail]);

  async function refreshConversations() {
    try {
      const data = await fetchJson<{ conversations: ConversationSummary[] }>('/api/conversations');
      setConversations(data.conversations);
      setError(null);
      if (!selectedId && data.conversations.length > 0) {
        setSelectedId(data.conversations[0].id);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to load conversations');
    }
  }

  async function handleSuppressToggle() {
    if (!detail) return;
    try {
      const response = await fetchJson<{
        suppress: boolean;
        manualSuppressedUntil: string | null;
        state: string;
        nextActionAt: string | null;
      }>(
        `/api/conversations/${detail.conversation.id}/suppress`,
        {
          method: 'POST',
          body: JSON.stringify({ suppress: !isSuppressed })
        }
      );
      setError(null);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              conversation: {
                ...prev.conversation,
                journey: prev.conversation.journey
                  ? {
                      ...prev.conversation.journey,
                      manualSuppressedUntil: response.manualSuppressedUntil,
                      state: response.state,
                      nextActionAt: response.nextActionAt ?? prev.conversation.journey.nextActionAt
                    }
                  : {
                      manualSuppressedUntil: response.manualSuppressedUntil,
                      state: response.state,
                      nextActionAt: response.nextActionAt ?? null
                    }
              }
            }
          : prev
      );
      void refreshConversations();
    } catch (err) {
      console.error(err);
      setError('Failed to update suppression');
    }
  }

  return (
    <div className="app-container">
      {error && <div className="error-banner">{error}</div>}
      <aside className="sidebar">
        <h2>Conversations</h2>
        {conversations.map((conversation) => {
          const active = conversation.id === selectedId;
          const suppressed = conversation.manualSuppressedUntil
            ? new Date(conversation.manualSuppressedUntil).getTime() > Date.now()
            : false;
          return (
            <div
              key={conversation.id}
              className={`conversation-item${active ? ' active' : ''}`}
              onClick={() => setSelectedId(conversation.id)}
            >
              <h3>{conversation.contactName}</h3>
              <p>{conversation.lastMessage || 'No messages yet.'}</p>
              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span className="status-pill">{conversation.status}</span>
                {suppressed && <span className="status-pill suppressed-pill">Paused</span>}
              </div>
            </div>
          );
        })}
      </aside>

      <section className="detail">
        {selectedId && detail ? (
          <>
            <div className="detail-header">
              <div>
                <h2 style={{ margin: 0 }}>{detail.conversation.contacts[0]?.name ?? 'Contact'}</h2>
                <p style={{ margin: '0.25rem 0 0', color: '#94a3b8', fontSize: '0.85rem' }}>
                  Lead #{detail.conversation.leadId} • Status {detail.conversation.status}
                </p>
              </div>
              <div className="suppression-toggle">
                <button className="button" onClick={handleSuppressToggle}>
                  {isSuppressed ? 'Resume automation' : 'Suppress automation 48h'}
                </button>
                {detail.conversation.journey?.manualSuppressedUntil && (
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    {isSuppressed
                      ? `Suppressed until ${formatDate(detail.conversation.journey.manualSuppressedUntil)}`
                      : 'Automation active'}
                  </span>
                )}
              </div>
            </div>
            <div className="thread">
              {detail.messages.length === 0 && !loadingDetail && (
                <div className="empty-state">No messages yet.</div>
              )}
              {detail.messages.map((message) => (
                <div
                  key={message.id}
                  className={`message ${message.direction === 'inbound' ? 'user' : 'assistant'}`}
                >
                  {message.body}
                  <span className="meta">{formatDate(message.createdAt)}</span>
                </div>
              ))}
              {loadingDetail && <div className="empty-state">Loading…</div>}
            </div>
          </>
        ) : (
          <div className="empty-state">
            {error ?? 'Select a conversation to inspect the transcript.'}
          </div>
        )}
      </section>
    </div>
  );
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const attempts = Number(import.meta.env.VITE_HTTP_RETRY_ATTEMPTS ?? 3);
  const timeoutMs = Number(import.meta.env.VITE_HTTP_TIMEOUT_MS ?? 10000);
  const backoffMs = Number(import.meta.env.VITE_HTTP_RETRY_BACKOFF_MS ?? 500);

  let attempt = 0;
  while (attempt < attempts) {
    attempt += 1;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        ...init
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Request failed (${response.status}): ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    } finally {
      window.clearTimeout(timer);
    }
  }

  throw new Error('Request failed');
}
