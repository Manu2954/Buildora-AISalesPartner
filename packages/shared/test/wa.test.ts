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
      text: async () => JSON.stringify({ sid: 'SM1234567890', status: 'accepted' })
    });

    const { sendTemplateWA } = await import('../src/wa.js');
    const result = await sendTemplateWA({
      phone: '919999999999',
      templateName: 'order_update',
      languageCode: 'en',
      variables: ['Buildora']
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/Messages.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
          'Content-Type': 'application/x-www-form-urlencoded'
        })
      })
    );
    const [, request] = fetchMock.mock.calls[0];
    const params = new URLSearchParams(request.body as string);
    expect(params.get('ContentSid')).toBe('HX1234567890ABCDEF1234567890ABCDEF');
    expect(JSON.parse(params.get('ContentVariables') ?? '{}')).toEqual({ '1': 'Buildora' });
    expect(result).toEqual({
      conversationId: null,
      messageId: 'SM1234567890',
      status: 'accepted'
    });
  });

  it('sends text replies when no mediaUrl provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ sid: 'SM222', status: 'sent' })
    });

    const { replyWA } = await import('../src/wa.js');
    const result = await replyWA({
      phone: '911234567890',
      text: 'Hello from Buildora'
    });

    expect(fetchMock).toHaveBeenCalled();
    const [, request] = fetchMock.mock.calls[0];
    const params = new URLSearchParams(request.body as string);
    expect(params.get('Body')).toBe('Hello from Buildora');
    expect(params.get('MediaUrl')).toBeNull();
    expect(result.messageId).toBe('SM222');
    expect(result.conversationId).toBeNull();
    expect(result.status).toBe('sent');
  });
});
