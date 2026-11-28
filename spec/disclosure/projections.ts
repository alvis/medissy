import { projectResource } from '../../src/vault/filter';
import {
  CARDIOLOGIST,
  ENC_CARDIO,
  ISSUER,
  PATIENT,
  T_GRANT_END,
  T_NOW,
  fixtureRecords,
} from '../policy/support';

import type { PolicyAllow } from '../../src/policy/decide';
import type { RecordProjection } from '../../src/vault/filter';

/**
 * builds filter-style projections of fixture records, references resolved within
 * the given set, all under grant-cardio@1
 * @param ids record ids to project
 * @param openConflicts ids to mark as under an open source conflict
 * @returns the projections, in fixture order
 */
export function projectionsFor(
  ids: readonly string[],
  openConflicts: readonly string[] = [],
): RecordProjection[] {
  const chosen = fixtureRecords.filter((record) => ids.includes(record.id));
  const scope = {
    patientId: PATIENT,
    released: new Set(
      chosen.map((record) => `${record.resourceType}/${record.resource.id}`),
    ),
  };

  return chosen.flatMap((record): RecordProjection[] => {
    const resource = projectResource(record, scope);

    return resource
      ? [
          {
            recordId: record.id,
            category: record.category,
            grant: { id: 'grant-cardio', version: 1 },
            source: {
              provider: record.source.provider,
              version: record.source.version,
              authoredAt: record.source.authoredAt,
              importedAt: record.source.importedAt,
              verification: record.source.verification,
            },
            resource,
            openConflict: openConflicts.includes(record.id),
          },
        ]
      : [];
  });
}

/**
 * builds an allow decision over exactly these projections
 * @param projections the projections the decision releases
 * @returns an allow releasing each projection under its grant
 */
export function decisionFor(
  projections: readonly RecordProjection[],
): PolicyAllow {
  return {
    effect: 'allow',
    rationaleCode: 'granted',
    policyVersion: 'medissy-policy/1',
    decidedAt: T_NOW,
    patientId: PATIENT,
    encounterId: ENC_CARDIO,
    purpose: 'direct-treatment',
    caller: { issuer: ISSUER, subject: CARDIOLOGIST, roles: [] },
    approvedCategories: [
      ...new Set(projections.map((projection) => projection.category)),
    ],
    records: projections.map((projection) => ({
      recordId: projection.recordId,
      category: projection.category,
      grant: projection.grant,
    })),
    expiresAt: T_GRANT_END,
  };
}
