import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

describe('Calendar helpers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const baseTime = DateTime.fromISO('2024-04-10T02:30:00Z'); // 08:00 IST

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.useFakeTimers();
    vi.setSystemTime(baseTime.toJSDate());
    vi.stubGlobal('fetch', fetchMock);
    const { __internal } = await import('../src/calendar.js');
    __internal.clearTokenCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers slots avoiding busy intervals', async () => {
    const busyStart = baseTime.plus({ hours: 4 }).setZone('Asia/Kolkata'); // 12:30 IST
    const busyEnd = busyStart.plus({ minutes: 60 });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token', expires_in: 3600 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            {
              start: { dateTime: busyStart.toISO() },
              end: { dateTime: busyEnd.toISO() }
            }
          ]
        })
      });

    const { offerSlots } = await import('../src/calendar.js');
    const slots = await offerSlots({ leadId: 'lead-1', durationMin: 60 });

    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(
      slots.every((slot) => {
        const candidate = DateTime.fromISO(slot);
        return candidate.hour >= 10 && candidate.hour < 19;
      })
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('books a slot and returns event summary', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token', expires_in: 3600 })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'event-123',
          summary: 'Buildora consultation',
          htmlLink: 'https://calendar.google.com/event?eid=123',
          start: { dateTime: '2024-04-10T11:00:00+05:30' },
          end: { dateTime: '2024-04-10T12:00:00+05:30' }
        })
      });

    const { bookSlot, __internal } = await import('../src/calendar.js');
    __internal.clearTokenCache();

    const result = await bookSlot({
      leadId: 'lead-2',
      slotIso: '2024-04-10T11:00:00+05:30',
      location: 'Buildora HQ',
      durationMin: 60
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.eventId).toBe('event-123');
    expect(result.summary).toBe('Buildora consultation');
    expect(result.htmlLink).toBeDefined();
  });
});
