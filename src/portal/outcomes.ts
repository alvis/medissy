/**
 * fixed pages for sharing refusals; a refusal never echoes input and names
 * no internal detail beyond its stable code
 */
import { messagePage } from './layout';

import type { SharingDenialCode } from '../sharing';

import type { Page } from './layout';

const REFUSALS: Readonly<
  Record<SharingDenialCode, { status: number; message: string }>
> = {
  'not-permitted': {
    status: 403,
    message: 'This action is not permitted for this sign-in.',
  },
  'not-found': { status: 404, message: 'Nothing matches that request.' },
  'invalid-input': {
    status: 400,
    message:
      'Some choices were missing or outside the allowed range. Nothing changed.',
  },
  'not-pending': {
    status: 409,
    message: 'This request was already decided. Nothing changed.',
  },
  'expired': {
    status: 410,
    message: 'This request expired before it was decided. Nothing was shared.',
  },
  'conflict': {
    status: 409,
    message:
      'A different request already used that request id. Nothing changed.',
  },
  'invitation-unavailable': {
    status: 404,
    message:
      'This invitation is not available. Ask the patient for a new share code.',
  },
};

/**
 * builds the page for a refusal
 * @param code why the decision was refused
 * @param next where to go next
 * @returns the page that explains why nothing changed
 */
export function refusalPage(code: SharingDenialCode, next: string): Page {
  const refusal = REFUSALS[code];

  return messagePage({
    status: refusal.status,
    title: 'Nothing changed',
    message: refusal.message,
    next: { href: next, label: 'Back' },
  });
}
