/**
 * conflict pairing (brief §7 step 4): a selector may not silently drop one
 * side of a known source conflict; when one record of a curated conflict link
 * is selected, every other member that is already in the allowed projection
 * set is added beside it; a member outside the allowed set is never added and
 * never mentioned, so pairing cannot widen access or hint at hidden records
 *
 * open source conflicts (a stored file with an unresolved newer copy) have no
 * releasable partner: the incoming copy never leaves the vault; they produce a
 * marker only, so the clinician sees that the shown version is under review
 */
import { z } from 'zod';

import { idSchema, LIMITS } from '../contracts';

import type { RecordProjection } from '../vault/filter';

/** the most members one curated conflict link may name */
const MAX_LINK_MEMBERS = LIMITS.listTiny;

/** a curated link between records whose sources disagree */
export const conflictLinkSchema = z.strictObject({
  /** a short, content-free topic code such as `anticoagulant` */
  topic: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  recordIds: z
    .array(idSchema)
    .min(2)
    .max(MAX_LINK_MEMBERS)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'record ids must be unique',
    ),
});
export type ConflictLink = z.infer<typeof conflictLinkSchema>;

/** the conflict list of the curated fixture manifest; other keys are ignored */
const manifestConflictsSchema = z.looseObject({
  conflicts: z
    .array(
      z.looseObject({
        topic: z.unknown(),
        recordIds: z.unknown(),
      }),
    )
    .max(LIMITS.listMedium),
});

/** a conflict the clinician is told about; only released ids appear */
export type ConflictMarker =
  | { kind: 'linked'; topic: string; recordIds: string[] }
  | { kind: 'open-source-conflict'; recordId: string };

/** what pairing produced */
export interface PairingResult {
  /** the selection plus every allowed partner it pulled in */
  recordIds: string[];
  /** conflicts among `recordIds`, for the result's limitations */
  markers: ConflictMarker[];
}

/** what pairing works on */
export interface PairingParams {
  /** the selector's output, in its order */
  selectedIds: readonly string[];
  /** the filter's allowed projections; the only ids pairing may add */
  projections: readonly RecordProjection[];
  /** the curated conflict links */
  links: readonly ConflictLink[];
}

/**
 * reads the curated conflict links from a parsed fixture manifest; free-text
 * notes are discarded; only the topic code and record ids are kept
 * @param manifest the parsed manifest JSON
 * @returns the validated links
 */
export function parseConflictLinks(manifest: unknown): ConflictLink[] {
  const { conflicts } = manifestConflictsSchema.parse(manifest);

  return conflicts.map((conflict) =>
    conflictLinkSchema.parse({
      topic: conflict.topic,
      recordIds: conflict.recordIds,
    }),
  );
}

/**
 * adds the allowed partners of every selected conflict member, to a fixpoint
 * (links may share members), and marks the conflicts among the result; ids in
 * the selection that are not allowed are passed through untouched so the
 * release guard can refuse them; pairing itself never filters or widens
 * @param params the selection, the allowed projections and the links
 * @returns the paired ids and the conflict markers
 */
export function pairConflicts(params: PairingParams): PairingResult {
  const { selectedIds, projections, links } = params;
  const allowed = new Set(projections.map((projection) => projection.recordId));
  const chosen = new Set(selectedIds);
  let grew = true;

  while (grew) {
    grew = false;

    for (const link of links) {
      grew = addPartners(link, chosen, allowed) || grew;
    }
  }

  const added = projections
    .map((projection) => projection.recordId)
    .filter((id) => chosen.has(id) && !selectedIds.includes(id));
  const recordIds = [...new Set(selectedIds), ...added];

  return {
    recordIds,
    markers: markConflicts(new Set(recordIds), projections, links),
  };
}

/**
 * finds the conflicts visible inside a set of released ids: a link with at least two
 * released members, and every released record with an open source conflict
 * @param released the ids that will be released
 * @param projections the allowed projections
 * @param links the curated conflict links
 * @returns the markers, links first, each listing released ids only
 */
export function markConflicts(
  released: ReadonlySet<string>,
  projections: readonly RecordProjection[],
  links: readonly ConflictLink[],
): ConflictMarker[] {
  const linked = links.flatMap((link): ConflictMarker[] => {
    const members = link.recordIds.filter((id) => released.has(id));

    return members.length >= 2
      ? [{ kind: 'linked', topic: link.topic, recordIds: members }]
      : [];
  });
  const open = projections.flatMap((projection): ConflictMarker[] =>
    projection.openConflict && released.has(projection.recordId)
      ? [{ kind: 'open-source-conflict', recordId: projection.recordId }]
      : [],
  );

  return [...linked, ...open];
}

/**
 * adds a link's allowed members to the chosen set when any member is chosen
 * @param link a curated conflict link
 * @param chosen the ids chosen so far; grown in place
 * @param allowed the ids the filter allows
 * @returns true when at least one id was added
 */
function addPartners(
  link: ConflictLink,
  chosen: Set<string>,
  allowed: ReadonlySet<string>,
): boolean {
  if (!link.recordIds.some((id) => chosen.has(id))) {
    return false;
  }

  const partners = link.recordIds.filter(
    (id) => allowed.has(id) && !chosen.has(id),
  );

  for (const id of partners) {
    chosen.add(id);
  }

  return partners.length > 0;
}
