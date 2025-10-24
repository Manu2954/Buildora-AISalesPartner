import { Prisma, prisma, AppError } from '@buildora/shared';

export type TranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  meta: Prisma.JsonValue | null;
};

export type LeadContext = {
  id: string;
  status: string;
  intentScore: number;
  city: string | null;
  locality: string | null;
  propertyType: string | null;
};

export type ContactContext = {
  id: string;
  name: string | null;
  phone: string | null;
  role: string | null;
  preferredChannel: string | null;
  whatsappOptIn: boolean;
  dndFlag: boolean;
};

type ContactEntity = Prisma.ContactGetPayload<{
  select: {
    id: true;
    name: true;
    phone: true;
    role: true;
    preferredChannel: true;
    whatsappOptIn: true;
    dndFlag: true;
  };
}>;

export type ConversationContext = {
  conversationId: string;
  channel: string;
  lead: LeadContext;
  contact: ContactContext | null;
  messages: TranscriptMessage[];
  latestUserMessage: string | null;
  latestUserMessageAt: Date | null;
  openConversationCount: number | null;
};

type LoadOptions = {
  limit?: number;
};

export async function loadConversationContext(
  conversationId: string,
  options: LoadOptions = {}
): Promise<ConversationContext> {
  const limit = options.limit ?? 15;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      Lead: {
        include: {
          contacts: {
            select: {
              id: true,
              name: true,
              phone: true,
              role: true,
              preferredChannel: true,
              whatsappOptIn: true,
              dndFlag: true
            }
          },
          quotes: {
            select: { status: true },
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          conversations: {
            select: { id: true, open: true },
            orderBy: { lastActivity: 'desc' },
            take: 5
          }
        }
      }
    }
  });

  if (!conversation || !conversation.Lead) {
    throw new AppError('CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found`, { status: 404 });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit
  });

  const sortedMessages = [...messages].reverse();
  const transcript: TranscriptMessage[] = sortedMessages.map((message) => ({
    id: message.id,
    role: message.direction === 'inbound' ? 'user' : 'assistant',
    content: message.body,
    createdAt: message.createdAt,
    meta: message.meta
  }));

  const lead: LeadContext = {
    id: conversation.Lead.id,
    status: conversation.Lead.status,
    intentScore: conversation.Lead.intentScore,
    city: conversation.Lead.city ?? null,
    locality: conversation.Lead.locality ?? null,
    propertyType: conversation.Lead.propertyType ?? null
  };

  const contact = selectPrimaryContact(conversation.Lead.contacts);
  const latestUserEntry = [...transcript].reverse().find((message) => message.role === 'user');
  const latestUserMessage = latestUserEntry?.content ?? null;
  const latestUserMessageAt = latestUserEntry?.createdAt ?? null;

  const openConversationCount =
    conversation.Lead.conversations?.filter((item) => item.open).length ?? null;

  return {
    conversationId,
    channel: conversation.channel,
    lead,
    contact,
    messages: transcript,
    latestUserMessage,
    latestUserMessageAt,
    openConversationCount
  };
}

function selectPrimaryContact(contacts: ContactEntity[]): ContactContext | null {
  if (!contacts || contacts.length === 0) {
    return null;
  }

  const score = (contact: ContactEntity) => {
    let value = 0;
    if (contact.preferredChannel === 'whatsapp') value += 5;
    if (contact.whatsappOptIn) value += 3;
    if (contact.phone) value += 2;
    if (!contact.dndFlag) value += 1;
    return value;
  };

  const sorted = [...contacts].sort((a, b) => score(b) - score(a));
  const primary = sorted[0];

  return {
    id: primary.id,
    name: primary.name ?? null,
    phone: primary.phone ?? null,
    role: primary.role ?? null,
    preferredChannel: primary.preferredChannel ?? null,
    whatsappOptIn: primary.whatsappOptIn,
    dndFlag: primary.dndFlag
  };
}
