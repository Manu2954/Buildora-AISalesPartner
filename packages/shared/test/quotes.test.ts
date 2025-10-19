import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }

  class S3Client {
    send = sendMock;
  }

  return {
    S3Client,
    PutObjectCommand
  };
});

describe('Quote PDF generator', () => {
  beforeEach(async () => {
    sendMock.mockReset();
    const { __internal } = await import('../src/quotes.js');
    __internal.resetClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads generated PDF to object storage', async () => {
    sendMock.mockResolvedValueOnce({});

    const { generateQuotePdf } = await import('../src/quotes.js');
    const result = await generateQuotePdf({
      leadId: 'lead-42',
      packageKey: 'kitchen_refresh',
      amountLow: 120000,
      amountHigh: 180000
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ input }] = sendMock.mock.calls[0] as [{ input: any }];
    expect(input.Key).toContain('lead-42');
    expect(input.ContentType).toBe('application/pdf');
    expect(result.url).toMatch(/quotes\/lead-42/);
  });
});
