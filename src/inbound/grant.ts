/**
 * who may hand a record back, and into which categories (ADR-10); the same
 * deny-by-default facts the clinical path relies on, read for the verified
 * clinician bound to the task: an active registry entry that still holds a
 * clinical role from its institution (ADR-9), a confirmed
 * connection, and at least one effective allow grant in force for them,
 * whose encounter admits them now; a deny grant in force for them removes
 * its categories; restricted categories are never a filing target
 */
import {
  ALWAYS_RESTRICTED_CATEGORIES,
  encounterAdmitsCaller,
  granteeMatches,
  isGrantInForce,
} from '../contracts';
import { readClinician, readEncounter, readGrants } from '../policy/repository';
import { hasConfirmedConnection } from '../sharing/queries';

import type { DatabaseSync } from 'node:sqlite';

import type {
  ClinicianEntry,
  GrantableCategory,
  GrantCaller,
  PersonRef,
} from '../contracts';

/** an active grant a clinician may file under */
export interface SubmissionGrant {
  /** the registry entry of the verified clinician */
  clinician: ClinicianEntry;
  /**
   * categories the clinician may file into, each with the allow grant (the
   * lowest id) that covers it, in grant order; the first is the default;
   * never baseline, never a restricted category; empty when the grants in
   * force cover baseline only
   */
  categories: Array<{ category: GrantableCategory; grantId: string }>;
}

/**
 * finds the active grant a verified clinician may file a record under
 * @param db the vault
 * @param input the verified person, the vault patient and the server clock
 * @param input.person the verified issuer and subject bound to the task
 * @param input.patientId the vault patient
 * @param input.now the server clock
 * @returns the grant and its fileable categories, or undefined (deny)
 */
export function submissionGrant(
  db: DatabaseSync,
  input: { person: PersonRef; patientId: string; now: Date },
): SubmissionGrant | undefined {
  const { person, patientId, now } = input;
  const clinician = readClinician(db, person);

  if (
    clinician?.status !== 'active' ||
    clinician.roles.length === 0 ||
    clinician.issuer !== person.issuer ||
    clinician.subject !== person.subject ||
    !hasConfirmedConnection(db, person)
  ) {
    return undefined;
  }

  const caller: GrantCaller = {
    issuer: clinician.issuer,
    subject: clinician.subject,
    organizationId: clinician.organizationId,
    roles: [...clinician.roles],
  };
  const applicable = readGrants(db, patientId).grants.filter((grant) => {
    const encounter = readEncounter(db, grant.encounterId);

    return (
      grant.patientId === patientId &&
      isGrantInForce(grant, now) &&
      granteeMatches(grant.grantee, caller) &&
      encounter?.patientId === patientId &&
      encounterAdmitsCaller(encounter, caller, now)
    );
  });
  const denied = new Set(
    applicable
      .filter((grant) => grant.effect === 'deny')
      .flatMap((grant) => grant.categories),
  );
  const categories = new Map<GrantableCategory, string>();

  for (const grant of applicable) {
    for (const category of grant.effect === 'allow' ? grant.categories : []) {
      const fileable =
        !denied.has(category) &&
        !ALWAYS_RESTRICTED_CATEGORIES.includes(category) &&
        !categories.has(category);

      if (fileable) {
        categories.set(category, grant.id);
      }
    }
  }

  return applicable.some((grant) => grant.effect === 'allow')
    ? {
        clinician,
        categories: [...categories].map(([category, grantId]) => ({
          category,
          grantId,
        })),
      }
    : undefined;
}
