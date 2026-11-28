/**
 * parse an incoming A2A message into what Medissy will do with it; pure and
 * SDK-free; the message text is untrusted data: it can carry a question and
 * an encounter selector, never an identity, a role or a permission
 *
 * accepted shapes (documented on the Agent Card skill):
 *
 * - a data part `{skill?, encounterId, question?, requestId?,
 *   requestedCategories?}` plus optional text parts holding the question;
 * - or, for text-only clients, one text part whose whole content is that
 *   JSON object (JSON-in-text);
 * - `{skill: "redeem-invitation", code}` where `code` is a share link
 *   (`<origin>/connect#<token>`) or its bare token; the token is hashed here
 *   and never travels further
 */
import { z } from 'zod';

import {
  clinicalRequestSchema,
  idSchema,
  LIMITS,
  MAX_QUESTION_LENGTH,
  recordCategorySchema,
  SKILL_SUBMIT_RECORD,
  submitRecordInputSchema,
} from '../contracts';

import {
  hashInvitationToken,
  INVITATION_TOKEN_SHAPE,
} from '../sharing/invitations';

import type { ClinicalRequest, SubmitRecordInput } from '../contracts';

/** the skills the Agent Card can advertise */
export const SKILL_CLINICAL = 'clinical-evidence-request';
export const SKILL_SHARE = 'share-code';
export const SKILL_REDEEM = 'redeem-invitation';
export const SKILL_SUBMIT = SKILL_SUBMIT_RECORD;

/** longest share link accepted as a `code` */
const MAX_CODE_LENGTH = 512;

/** longest messageId the task store accepts (migration 0005) */
const MAX_MESSAGE_ID_LENGTH = 256;
/** most parts a request message may carry */
const MAX_PARTS = LIMITS.listTiny;

/** one part of an incoming message, in A2A 1.0 JSON form */
export type IncomingPart =
  | { text: string }
  | { data: unknown; mediaType?: string }
  | Record<string, unknown>;

/** an incoming message as the engine sees it */
export interface IncomingMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  parts: readonly IncomingPart[];
}

/** what a message asks for */
export type Intent =
  | { kind: 'clinical'; request: ClinicalRequest }
  | { kind: 'share-code' }
  | { kind: 'redeem-invitation'; tokenHash: string }
  | { kind: 'submit-record'; submission: SubmitRecordInput }
  | { kind: 'invalid'; reason: InvalidReason };

/** why a message could not be understood; fixed codes, never echoed text */
export type InvalidReason =
  | 'message-id'
  | 'too-many-parts'
  | 'unsupported-part'
  | 'missing-fields'
  | 'invalid-fields';

/** help returned with an invalid message; it quotes nothing the caller sent */
export const REQUEST_HELP =
  'Send a data part {"skill":"clinical-evidence-request","encounterId":"<encounter id>","question":"<question>"} ' +
  '(optionally "requestId" and "requestedCategories"), or that JSON object as the only text. ' +
  'To redeem a patient\'s share link, send {"skill":"redeem-invitation","code":"<share link>"}. ' +
  'To hand a record back, send {"skill":"submit-record","record":<FHIR R4 resource>} or ' +
  '{"skill":"submit-record","document":{"title","text"}} (optionally "category"), at most 64 KiB, ' +
  'with no contained resources and no attachment URLs.';

const requestFieldsSchema = z.strictObject({
  skill: z.enum([SKILL_CLINICAL, SKILL_SHARE, SKILL_REDEEM]).optional(),
  code: z.string().max(MAX_CODE_LENGTH).optional(),
  encounterId: idSchema.optional(),
  question: z.string().max(MAX_QUESTION_LENGTH).optional(),
  requestId: idSchema.optional(),
  purpose: z.literal('direct-treatment').optional(),
  requestedCategories: z
    .array(recordCategorySchema)
    .min(1)
    .max(LIMITS.listSmall)
    .optional(),
});
type RequestFields = z.infer<typeof requestFieldsSchema>;

/**
 * returns the text of a text part, or undefined for any other part
 * @param part the incoming message part to read
 * @returns its text
 */
function textOf(part: IncomingPart): string | undefined {
  return 'text' in part && typeof part.text === 'string'
    ? part.text
    : undefined;
}

/**
 * parses JSON text into an object, or undefined
 * @param text candidate JSON-in-text
 * @returns the parsed value, or undefined when the text is not JSON
 */
function jsonObject(text: string): unknown {
  const trimmed = text.trim();

  if (!trimmed.startsWith('{')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * collects the structured fields and the free-text question
 * @param parts the message parts
 * @returns the raw fields and question text, or an invalid reason
 */
function collect(
  parts: readonly IncomingPart[],
): { fields: unknown; text: string } | { invalid: InvalidReason } {
  const data: unknown[] = [];
  const texts: string[] = [];

  for (const part of parts) {
    const text = textOf(part);

    if (text !== undefined) {
      texts.push(text);
    } else if ('data' in part) {
      data.push(part.data);
    } else {
      return { invalid: 'unsupported-part' };
    }
  }

  if (data.length > 1) {
    return { invalid: 'invalid-fields' };
  }

  if (data.length === 1) {
    return { fields: data[0], text: texts.join('\n') };
  }

  const embedded = texts.length === 1 ? jsonObject(texts[0] ?? '') : undefined;

  return embedded === undefined
    ? { fields: {}, text: texts.join('\n') }
    : { fields: embedded, text: '' };
}

/**
 * builds the clinical request from validated fields
 * @param fields the structured fields
 * @param text the free-text question, used when the fields carry none
 * @param messageId the message id, the default request id
 * @returns the intent
 */
function clinical(
  fields: RequestFields,
  text: string,
  messageId: string,
): Intent {
  const question = (fields.question ?? text).trim();
  const requestId = fields.requestId ?? messageId;

  if (!fields.encounterId || question === '') {
    return { kind: 'invalid', reason: 'missing-fields' };
  }

  const parsed = clinicalRequestSchema.safeParse({
    requestId,
    encounterId: fields.encounterId,
    purpose: fields.purpose ?? 'direct-treatment',
    question,
    requestedCategories: fields.requestedCategories,
  });

  return parsed.success
    ? { kind: 'clinical', request: parsed.data }
    : { kind: 'invalid', reason: 'invalid-fields' };
}

/**
 * returns the invitation token in a share link or bare code
 * @param code a share link or its token
 * @returns the token, or undefined when the code holds none
 */
function invitationToken(code: string): string | undefined {
  const trimmed = code.trim();

  if (INVITATION_TOKEN_SHAPE.test(trimmed)) {
    return trimmed;
  }

  try {
    const token = new URL(trimmed).hash.slice(1);

    return INVITATION_TOKEN_SHAPE.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * checks whether structured fields name the record-submission skill
 * @param fields the structured fields of a message
 * @returns true for `{"skill":"submit-record",…}`
 */
function isSubmission(fields: unknown): boolean {
  return (
    typeof fields === 'object' &&
    fields !== null &&
    'skill' in fields &&
    fields.skill === SKILL_SUBMIT
  );
}

/**
 * decides what a message asks for
 * @param message the incoming message
 * @returns the intent, or a fixed invalid reason
 */
export function parseIntent(message: IncomingMessage): Intent {
  if (
    message.messageId.length === 0 ||
    message.messageId.length > MAX_MESSAGE_ID_LENGTH
  ) {
    return { kind: 'invalid', reason: 'message-id' };
  }

  if (message.parts.length === 0 || message.parts.length > MAX_PARTS) {
    return { kind: 'invalid', reason: 'too-many-parts' };
  }

  const collected = collect(message.parts);

  if ('invalid' in collected) {
    return { kind: 'invalid', reason: collected.invalid };
  }

  if (isSubmission(collected.fields)) {
    const submission = submitRecordInputSchema.safeParse(collected.fields);

    // the record is untrusted clinical content: a shape refusal quotes
    // nothing back and files nothing
    return submission.success
      ? { kind: 'submit-record', submission: submission.data }
      : { kind: 'invalid', reason: 'invalid-fields' };
  }

  const fields = requestFieldsSchema.safeParse(collected.fields);

  if (!fields.success) {
    return { kind: 'invalid', reason: 'invalid-fields' };
  }

  if (fields.data.skill === SKILL_SHARE) {
    return { kind: 'share-code' };
  }

  if (fields.data.skill === SKILL_REDEEM) {
    const token = invitationToken(fields.data.code ?? '');

    return token
      ? { kind: 'redeem-invitation', tokenHash: hashInvitationToken(token) }
      : { kind: 'invalid', reason: 'invalid-fields' };
  }

  if (fields.data.code !== undefined) {
    return { kind: 'invalid', reason: 'invalid-fields' };
  }

  // the engine mints its own request id per task; this one only has to
  // satisfy the request contract
  const fallbackId = idSchema.safeParse(message.messageId).success
    ? message.messageId
    : 'request';

  return clinical(fields.data, collected.text, fallbackId);
}
