import { prisma, env, AppError, redactPhone } from '@buildora/shared';

import { McpClient } from '../apps/assistant/src/mcpClient.js';

const DEFAULT_PHONE = process.env.DRYRUN_PHONE ?? '+919990000000';

async function main() {
  const phone = DEFAULT_PHONE;
  if (!phone) {
    throw new AppError('DRYRUN_PHONE_REQUIRED', 'Please set DRYRUN_PHONE or adjust the script with a target number.');
  }

  const client = new McpClient(env.MCP_SERVER_URL, 'dryrun-script');

  const { leadId, contactId, phoneNumber } = await seedLeadAndContact(phone);

  await ensureConsent(client, contactId);

  await client.callTool('message.send.whatsapp_template', {
    contactId,
    leadId,
    phone: phoneNumber,
    templateName: 'buildora_intro_v2',
    languageCode: 'en',
    variables: ['Neha', '3BHK', 'Andheri']
  });
  console.log('✅ Sent intro template to', redactPhone(phoneNumber));

  const offerResult = await client.callTool<{ leadId: string; durationMin: number }, { slots: string[] }>(
    'calendar.offer_slots',
    {
      leadId,
      durationMin: 30
    }
  );

  console.log('📅 Slots:', offerResult.slots);
}

async function seedLeadAndContact(phone: string) {
  const normalized = phone.replace(/\s+/g, '');

  const existingContact = await prisma.contact.findFirst({
    where: { phone: normalized },
    include: { Lead: true }
  });

  if (existingContact?.Lead) {
    return {
      leadId: existingContact.Lead.id,
      contactId: existingContact.id,
      phoneNumber: existingContact.phone ?? normalized
    };
  }

  const seeded = await prisma.lead.create({
      data: {
        source: 'dryrun',
        status: 'new',
        intentScore: 0,
        contacts: {
          create: {
            phone: normalized,
            whatsappOptIn: false,
            preferredChannel: 'whatsapp'
          }
        }
      },
      include: { contacts: true }
    });

  const seededContact = seeded.contacts[0];
  console.log('🌱 Seeded new lead', seeded.id, 'with contact', seededContact.id);

  return {
    leadId: seeded.id,
    contactId: seededContact.id,
    phoneNumber: seededContact.phone ?? normalized
  };
}

async function ensureConsent(client: McpClient, contactId: string) {
  const consent = await client.callTool<{ contactId: string; channel: string }, { status: string }>('consent.check', {
    contactId,
    channel: 'whatsapp'
  });

  if (consent.status === 'granted') {
    return;
  }

  await client.callTool(
    'consent.record',
    {
      contactId,
      channel: 'whatsapp',
      status: 'granted',
      proof: { note: 'dryrun seed' }
    }
  );

  console.log('✅ Granted WhatsApp consent for contact', contactId);
}

void main()
  .catch((error) => {
    console.error('Dryrun failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
