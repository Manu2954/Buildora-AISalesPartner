type LeadSnapshot = {
  id: string;
  status?: string | null;
  intentScore?: number | null;
  city?: string | null;
  locality?: string | null;
  propertyType?: string | null;
};

type SanitizedLead = Record<string, unknown>;

type ContactSnapshot = {
  id: string;
  name?: string | null;
  phone?: string | null;
  role?: string | null;
  preferredChannel?: string | null;
};

type ConversationMetadata = {
  channel: string;
  latestUserMessage?: string | null;
  openConversationCount?: number | null;
};

export type DeveloperPromptContext = {
  lead: LeadSnapshot;
  sanitizedLead?: SanitizedLead | null;
  contact?: ContactSnapshot | null;
  conversation: ConversationMetadata;
};

export function buildDeveloperPrompt(context: DeveloperPromptContext): string {
  const { lead, sanitizedLead, contact, conversation } = context;
  const lines: string[] = [];

  lines.push(`Lead summary:`);
  lines.push(`- id: ${lead.id}`);
  lines.push(`- status: ${lead.status ?? 'unknown'}`);
  lines.push(`- intentScore: ${lead.intentScore ?? 0}`);
  if (lead.city) lines.push(`- city: ${lead.city}`);
  if (lead.locality) lines.push(`- locality: ${lead.locality}`);
  if (lead.propertyType) lines.push(`- propertyType: ${lead.propertyType}`);

  if (contact) {
    lines.push(`Contact (primary):`);
    lines.push(`- id: ${contact.id}`);
    if (contact.name) lines.push(`- name: ${contact.name}`);
    if (contact.phone) lines.push(`- phone: ${contact.phone}`);
    if (contact.role) lines.push(`- role: ${contact.role}`);
    if (contact.preferredChannel) lines.push(`- preferredChannel: ${contact.preferredChannel}`);
  }

  if (sanitizedLead) {
    lines.push(`Sanitized lead context (tool view): ${JSON.stringify(sanitizedLead)}`);
  }

  lines.push(`Conversation:`);
  lines.push(`- channel: ${conversation.channel}`);
  if (conversation.latestUserMessage) {
    lines.push(`- latestUserMessage: "${conversation.latestUserMessage}"`);
  }
  if (conversation.openConversationCount !== undefined && conversation.openConversationCount !== null) {
    lines.push(`- parallel open conversations: ${conversation.openConversationCount}`);
  }

  lines.push('');
  lines.push(
    'Always respect consent, avoid sending media unless necessary, and keep summaries actionable. If you cannot fulfil a request (e.g., missing slots, no consent), explain next steps clearly.'
  );

  return lines.join('\n');
}
