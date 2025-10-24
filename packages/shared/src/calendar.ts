import { createPrivateKey, createSign } from 'node:crypto';

import { DateTime } from 'luxon';

import { env } from './env.js';
import { AppError } from './errors.js';

const GCAL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const IST_ZONE = env.TIMEZONE ?? 'Asia/Kolkata';
const SLOT_WINDOW_DAYS = 5;
const WORK_START_HOUR = 10;
const WORK_END_HOUR = 19;
const SLOT_INCREMENT_MIN = 30;
const MIN_SLOTS = 2;
const MAX_SLOTS = 4;

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type GoogleCalendarEvent = {
  id?: string;
  htmlLink?: string;
  summary?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; timeZone?: string; date?: string };
  end?: { dateTime?: string; timeZone?: string; date?: string };
};

type OfferSlotsInput = {
  leadId: string;
  durationMin: number;
};

type BookSlotInput = {
  leadId: string;
  slotIso: string;
  location?: string;
  durationMin?: number;
};

type BookSlotResult = {
  eventId: string;
  summary: string;
  htmlLink?: string;
  start: string;
  end: string;
  hangoutLink?: string;
};

let cachedCredentials: ServiceAccountCredentials | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function offerSlots({ leadId, durationMin }: OfferSlotsInput): Promise<string[]> {
  if (!env.GCAL_CALENDAR_ID) {
    throw new AppError('GCAL_CALENDAR_ID_MISSING', 'GCAL_CALENDAR_ID must be configured to offer slots');
  }
  if (durationMin <= 0) {
    throw new AppError('INVALID_DURATION', 'durationMin must be positive', { status: 400 });
  }

  const nowIst = DateTime.now().setZone(IST_ZONE);
  const timeMin = nowIst.toUTC().toISO();
  const timeMax = nowIst.plus({ days: SLOT_WINDOW_DAYS }).toUTC().toISO();

  const events = await listEvents(timeMin, timeMax);
  const busyIntervals = events
    .map((event) => normalizeEventInterval(event))
    .filter((interval): interval is { start: DateTime; end: DateTime } => interval !== null);

  const slots: string[] = [];
  for (let dayOffset = 0; dayOffset <= SLOT_WINDOW_DAYS; dayOffset += 1) {
    const dayStart = nowIst.plus({ days: dayOffset }).set({ hour: WORK_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    const dayEnd = nowIst.plus({ days: dayOffset }).set({ hour: WORK_END_HOUR, minute: 0, second: 0, millisecond: 0 });

    let candidate = dayStart;
    while (candidate < dayEnd) {
      const candidateEnd = candidate.plus({ minutes: durationMin });
      if (candidate < nowIst.plus({ minutes: 30 })) {
        candidate = candidate.plus({ minutes: SLOT_INCREMENT_MIN });
        continue;
      }
      if (candidateEnd > dayEnd) {
        break;
      }

      const overlapsBusy = busyIntervals.some(({ start, end }) => intervalsOverlap(candidate, candidateEnd, start, end));
      if (!overlapsBusy) {
        slots.push(candidate.setZone(IST_ZONE).toISO({ suppressMilliseconds: true }));
        if (slots.length === MAX_SLOTS) {
          return ensureMinimumSlots(slots);
        }
      }

      candidate = candidate.plus({ minutes: Math.max(SLOT_INCREMENT_MIN, durationMin) });
    }
  }

  return ensureMinimumSlots(slots);
}

export async function bookSlot({
  leadId,
  slotIso,
  location,
  durationMin = 60
}: BookSlotInput): Promise<BookSlotResult> {
  if (!env.GCAL_CALENDAR_ID) {
    throw new AppError('GCAL_CALENDAR_ID_MISSING', 'GCAL_CALENDAR_ID must be configured to book slots');
  }

  const slotStart = DateTime.fromISO(slotIso, { zone: IST_ZONE });
  if (!slotStart.isValid) {
    throw new AppError('INVALID_SLOT', 'slotIso must be a valid ISO date string', { status: 400 });
  }

  const slotEnd = slotStart.plus({ minutes: durationMin });
  const accessToken = await getGoogleAccessToken();

  const summary = `Buildora consultation for Lead ${leadId}`;
  const body = {
    summary,
    description: `Consultation scheduled by Buildora automation for lead ${leadId}`,
    location,
    start: {
      dateTime: slotStart.toISO({ suppressMilliseconds: true }),
      timeZone: IST_ZONE
    },
    end: {
      dateTime: slotEnd.toISO({ suppressMilliseconds: true }),
      timeZone: IST_ZONE
    }
  };

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GCAL_CALENDAR_ID)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new AppError('GCAL_CREATE_EVENT_FAILED', `Failed to create calendar event: ${response.status} ${errorBody}`, {
      status: response.status
    });
  }

  const payload = (await response.json()) as GoogleCalendarEvent;
  const startDate = payload.start?.dateTime ?? slotStart.toISO({ suppressMilliseconds: true });
  const endDate = payload.end?.dateTime ?? slotEnd.toISO({ suppressMilliseconds: true });

  return {
    eventId: payload.id ?? '',
    summary: payload.summary ?? summary,
    htmlLink: payload.htmlLink,
    start: startDate,
    end: endDate,
    hangoutLink: payload.hangoutLink
  };
}

async function listEvents(timeMin: string, timeMax: string): Promise<GoogleCalendarEvent[]> {
  const accessToken = await getGoogleAccessToken();
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GCAL_CALENDAR_ID!)}/events`
  );
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new AppError('GCAL_FETCH_EVENTS_FAILED', `Failed to fetch calendar events: ${response.status} ${errorBody}`, {
      status: response.status
    });
  }

  const payload = (await response.json()) as { items?: GoogleCalendarEvent[] };
  return payload.items ?? [];
}

function normalizeEventInterval(event: GoogleCalendarEvent): { start: DateTime; end: DateTime } | null {
  const startISO = event.start?.dateTime ?? event.start?.date;
  const endISO = event.end?.dateTime ?? event.end?.date;
  if (!startISO || !endISO) {
    return null;
  }

  const start = DateTime.fromISO(startISO, { zone: event.start?.timeZone ?? IST_ZONE }).setZone(IST_ZONE);
  const end = DateTime.fromISO(endISO, { zone: event.end?.timeZone ?? IST_ZONE }).setZone(IST_ZONE);
  if (!start.isValid || !end.isValid || end <= start) {
    return null;
  }

  return { start, end };
}

function intervalsOverlap(
  startA: DateTime,
  endA: DateTime,
  startB: DateTime,
  endB: DateTime
): boolean {
  return startA < endB && startB < endA;
}

function ensureMinimumSlots(slots: string[]): string[] {
  if (slots.length >= MIN_SLOTS) {
    return slots.slice(0, Math.min(MAX_SLOTS, slots.length));
  }
  if (slots.length === 0) {
    throw new AppError('NO_SLOTS_AVAILABLE', 'No available slots within the configured window');
  }
  const lastSlot = DateTime.fromISO(slots[slots.length - 1], { zone: IST_ZONE });
  const paddedSlots = [...slots];
  while (paddedSlots.length < MIN_SLOTS) {
    paddedSlots.push(
      lastSlot
        .plus({ minutes: SLOT_INCREMENT_MIN * paddedSlots.length })
        .toISO({ suppressMilliseconds: true })
    );
  }
  return paddedSlots.slice(0, Math.min(MAX_SLOTS, paddedSlots.length));
}

async function getGoogleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const credentials = getServiceAccountCredentials();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiry = nowSeconds + 3600;

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: credentials.client_email,
      scope: GCAL_SCOPE,
      aud: credentials.token_uri ?? GCAL_TOKEN_ENDPOINT,
      exp: expiry,
      iat: nowSeconds
    })
  );

  const signingInput = `${header}.${claimSet}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .end()
    .sign(createPrivateKey(credentials.private_key));
  const jwt = `${signingInput}.${base64UrlEncodeBuffer(signature)}`;

  const body = new URLSearchParams();
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  body.set('assertion', jwt);

  const response = await fetch(credentials.token_uri ?? GCAL_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new AppError('GCAL_AUTH_FAILED', `Failed to exchange JWT for access token: ${response.status} ${errorBody}`, {
      status: response.status
    });
  }

  const payload = (await response.json()) as { access_token: string; expires_in?: number };
  const expiresAt =
    Date.now() + Math.max(0, (payload.expires_in ?? 3600) - 60) * 1000;
  cachedToken = { token: payload.access_token, expiresAt };
  return payload.access_token;
}

function getServiceAccountCredentials(): ServiceAccountCredentials {
  if (cachedCredentials) {
    return cachedCredentials;
  }
  if (!env.GCAL_CREDENTIALS_JSON_BASE64) {
    throw new AppError('GCAL_CREDENTIALS_MISSING', 'GCAL_CREDENTIALS_JSON_BASE64 must be configured for calendar access');
  }

  const decoded = Buffer.from(env.GCAL_CREDENTIALS_JSON_BASE64, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new AppError('GCAL_CREDENTIALS_INVALID', 'GCAL credentials must include client_email and private_key');
  }

  cachedCredentials = {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
    token_uri: parsed.token_uri ?? GCAL_TOKEN_ENDPOINT
  };
  return cachedCredentials;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlEncodeBuffer(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export const __internal = {
  clearTokenCache() {
    cachedToken = null;
  }
};
