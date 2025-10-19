import { handleTurn } from './orchestrator.js';
import type { DialogueJob } from './queues.js';

export type DialogueTurnPayload = DialogueJob;

export async function processTurn(payload: DialogueTurnPayload): Promise<void> {
  await handleTurn(payload.conversationId, {
    leadId: payload.leadId,
    contactId: payload.contactId,
    triggerMessageId: payload.messageId
  });
}
