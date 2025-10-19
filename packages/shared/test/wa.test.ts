import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('WhatsApp client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends template messages and parses response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meta: { conversation_id: 'conv-1' },
        messages: [{ id: 'wamid.HBgL', message_status: 'accepted' }]
      })
    });

    const { sendTemplateWA } = await import('../src/wa.js');
    const result = await sendTemplateWA({
      phone: '919999999999',
      templateName: 'order_update',
      languageCode: 'en',
      variables: ['Buildora']
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v17.0/123456789/messages',
      expect.objectContaining({
        method: 'POST'
      })
    );
    expect(result).toEqual({
      conversationId: 'conv-1',
      messageId: 'wamid.HBgL',
      status: 'accepted'
    });
  });

  it('sends text replies when no mediaUrl provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [{ id: 'wamid.2', message_status: 'sent', conversation: { id: 'conv-2' } }]
      })
    });

    const { replyWA } = await import('../src/wa.js');
    const result = await replyWA({
      phone: '911234567890',
      text: 'Hello from Buildora'
    });

    expect(fetchMock).toHaveBeenCalled();
    const [, request] = fetchMock.mock.calls[0];
    const parsedBody = JSON.parse(request.body as string);
    expect(parsedBody.type).toBe('text');
    expect(result.messageId).toBe('wamid.2');
    expect(result.conversationId).toBe('conv-2');
    expect(result.status).toBe('sent');
  });
});
