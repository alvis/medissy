import { z } from 'zod';

import {
  idSchema,
  organizationIdSchema,
  personRefSchema,
  purposeSchema,
  timestampSchema,
  LIMITS,
} from './common';

import type { GrantCaller } from './grant';

/**
 * an encounter the owner confirmed (brief §5); it is created only by the
 * owner and read from the database; a caller-supplied encounter id is never
 * evidence of a treatment relationship
 */
export const encounterSchema = z
  .strictObject({
    id: idSchema,
    patientId: idSchema,
    purpose: purposeSchema,
    /** owner-entered free text; untrusted when rendered or sent to a model */
    reason: z.string().max(LIMITS.listLarge).optional(),
    clinician: personRefSchema.optional(),
    organizationId: organizationIdSchema.optional(),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    status: z.enum(['planned', 'active', 'closed', 'cancelled']),
    createdBy: personRefSchema,
    createdAt: timestampSchema,
  })
  .superRefine((encounter, context) => {
    if (
      encounter.clinician === undefined &&
      encounter.organizationId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['clinician'],
        message: 'an encounter needs a clinician or an organization',
      });
    }

    if (Date.parse(encounter.startsAt) >= Date.parse(encounter.endsAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
    }
  });
export type Encounter = z.infer<typeof encounterSchema>;

/** the encounter fields that decide whether a caller may act in it */
export type AdmittingEncounter = Pick<
  Encounter,
  'clinician' | 'endsAt' | 'organizationId' | 'startsAt' | 'status'
>;

/**
 * checks whether this encounter admits this caller now (step 2 of the release
 * predicate); the encounter must be `active`, satisfy `startsAt <= now < endsAt`,
 * and be linked to the caller: its clinician is the caller `(issuer, subject)`,
 * or its organization is the caller's registry organization; planned, closed and
 * cancelled encounters admit nobody; the encounter must be read from the
 * database by the request's selector; the request's own claims never count
 * @param encounter the encounter row
 * @param caller the verified caller with registry organization
 * @param now the server clock
 * @returns true when the caller may use the encounter at `now`
 */
export function encounterAdmitsCaller(
  encounter: AdmittingEncounter,
  caller: Pick<GrantCaller, 'issuer' | 'organizationId' | 'subject'>,
  now: Date,
): boolean {
  const at = now.getTime();
  const linkedClinician =
    encounter.clinician?.issuer === caller.issuer &&
    encounter.clinician.subject === caller.subject;
  const linkedOrganization =
    encounter.organizationId !== undefined &&
    encounter.organizationId === caller.organizationId;

  return (
    encounter.status === 'active' &&
    Date.parse(encounter.startsAt) <= at &&
    at < Date.parse(encounter.endsAt) &&
    (linkedClinician || linkedOrganization)
  );
}
