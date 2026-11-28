/**
 * plain-language descriptions of the conflicts flagged in a release; they
 * name released evidence only (the result schema guarantees every conflict
 * id is released), by its label; the strings are raw: the text part passes
 * them through `inertLine` and the card through the escaping `html` template
 */
import type { DisclosureConflict, DisclosureResult } from '../contracts';

/**
 * describes each conflict of a release
 * @param result the validated disclosure result
 * @returns one raw description per conflict
 */
export function describeConflicts(result: DisclosureResult): string[] {
  const labels = new Map(
    result.evidence.map((item) => [item.recordId, item.label]),
  );
  const name = (recordId: string): string => labels.get(recordId) ?? recordId;

  return result.conflicts.map((conflict: DisclosureConflict) =>
    conflict.kind === 'linked'
      ? `Sources disagree on ${conflict.topic}: ${conflict.recordIds.map(name).join(' vs ')}`
      : `The source of ${name(conflict.recordId)} has a newer copy not yet reviewed by the patient`,
  );
}
