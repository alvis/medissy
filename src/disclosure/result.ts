/**
 * deterministic rendering of a release (brief §7 step 7); every evidence card
 * and every bundle entry is built from the guarded projections only: no model
 * text, no vault read, no field outside the allowlist; the bundle is a FHIR R4
 * `collection` of the released resources; it makes no IPS conformance claim
 *
 * denials are fixed sentences per code: they carry no record id, no count and
 * no hint of what exists
 */
import { disclosureResultSchema, LIMITS, SELECTIVE_NOTICE } from '../contracts';

import { toBundle } from './bundle';

import type {
  DisclosureConflict,
  DisclosureDenial,
  DisclosureResult,
  EvidenceItem,
} from '../contracts';
import type { PolicyAllow } from '../policy/decide';
import type {
  ProjectedResource,
  ProjectedValue,
  RecordProjection,
} from '../vault/filter';

import type { ConflictMarker } from './pairing';
import type { SelectionPath } from './receipt';

/** the clinician-facing denial codes */
export type DenialCode = DisclosureDenial['code'];

/** everything a result is rendered from */
export interface RenderParams {
  requestId: string;
  receiptId: string;
  /** the decision the release is made under */
  decision: PolicyAllow;
  /** the guarded, closed projections, in release order */
  projections: readonly RecordProjection[];
  markers: readonly ConflictMarker[];
  selection: SelectionPath;
  lastSyncAt?: string;
  /** the bundle timestamp */
  issuedAt: string;
}

/** the limitation shown with every release */
export const ABSENCE_LIMITATION =
  'This extract cannot establish the absence of any condition, medication or allergy.';

/** the limitation shown when relevance selection fell back to the approved baseline */
export const FALLBACK_LIMITATION =
  'Relevance selection was unavailable, so only the approved baseline is shown and the extract is incomplete.';

/** the limitation shown with every release */
export const SOURCE_LIMITATION =
  'Items are copies of imported source files; check each source and import date for freshness.';

const DENIAL_TEXT: Readonly<
  Record<
    DenialCode,
    { kind: DisclosureDenial['kind']; message: string; nextStep?: string }
  >
> = {
  'access-required': {
    kind: 'access_required',
    message: 'Sign-in is required before any records can be shared.',
  },
  'not-permitted': {
    kind: 'denied',
    message: 'No records can be shared for this request.',
    nextStep:
      'Ask the patient to review sharing for this encounter, then send a new request.',
  },
  'invalid-request': {
    kind: 'denied',
    message: 'The request could not be processed as sent.',
    nextStep: 'Check the request, then send it as a new request.',
  },
  'temporarily-unavailable': {
    kind: 'denied',
    message: 'Records cannot be shared right now; nothing was released.',
    nextStep: 'Try again later with a new request.',
  },
};

const ELLIPSIS = '…';

/**
 * renders a release as a validated `DisclosureResult`
 * @param params the decision, projections, markers and metadata
 * @returns a result validated against `disclosureResultSchema`
 * @throws {Error} when the rendered result fails its contract
 */
export function renderResult(params: RenderParams): DisclosureResult {
  const { decision, projections } = params;
  const categories = new Set(projections.map((item) => item.category));

  return disclosureResultSchema.parse({
    requestId: params.requestId,
    receiptId: params.receiptId,
    kind: 'selective-evidence',
    scope: {
      purpose: decision.purpose,
      encounterId: decision.encounterId,
      categories: decision.approvedCategories.filter((category) =>
        categories.has(category),
      ),
      expiresAt: decision.expiresAt,
    },
    notice: SELECTIVE_NOTICE,
    evidence: projections.map(toEvidence),
    conflicts: params.markers.map((marker): DisclosureConflict =>
      marker.kind === 'linked'
        ? {
            kind: 'linked',
            topic: marker.topic,
            recordIds: [...marker.recordIds],
          }
        : { kind: 'open-source-conflict', recordId: marker.recordId },
    ),
    coverage: {
      lastSyncAt: params.lastSyncAt,
      limitations: limitationsFor(params),
    },
    bundle: toBundle(projections, {
      issuedAt: params.issuedAt,
      receiptId: params.receiptId,
    }),
  });
}

/**
 * builds a safe denial for a code; the same text for every reason behind the code
 * @param requestId the caller's request id
 * @param code the clinician-facing code
 * @returns the fixed kind, message and next step for the code
 */
export function renderDenial(
  requestId: string,
  code: DenialCode,
): DisclosureDenial {
  const { kind, message, nextStep } = DENIAL_TEXT[code];

  return nextStep
    ? { requestId, kind, code, message, nextStep }
    : { requestId, kind, code, message };
}

/**
 * builds the limitations of a release: fixed sentences plus one per conflict marker
 * @param params the render parameters
 * @returns at most `LIMITS.listShort` bounded sentences
 */
function limitationsFor(params: RenderParams): string[] {
  const conflicts = params.markers.map((marker) =>
    marker.kind === 'linked'
      ? `Sources conflict (${marker.topic}): ${marker.recordIds.join(', ')} are shown side by side and not reconciled.`
      : `A newer copy of the source for ${marker.recordId} awaits review; the originally imported version is shown.`,
  );
  const fixed = [
    ABSENCE_LIMITATION,
    ...(params.selection === 'fallback' ? [FALLBACK_LIMITATION] : []),
    SOURCE_LIMITATION,
  ];

  return [...fixed, ...conflicts]
    .slice(0, LIMITS.listShort)
    .map((text) => bounded(text, LIMITS.sentence));
}

/**
 * builds one evidence card, grounded in the projection only
 * @param projection the released projection
 * @returns the card
 */
function toEvidence(projection: RecordProjection): EvidenceItem {
  const { recordId, resource, source } = projection;
  const { label, facts } = describe(resource);
  const factualValue = facts.filter((fact) => fact.length > 0).join('; ');

  return {
    recordId,
    label: bounded(label, LIMITS.line),
    ...(factualValue
      ? { factualValue: bounded(factualValue, LIMITS.listLarge) }
      : {}),
    source: bounded(
      `${source.provider} (version ${source.version})`,
      LIMITS.line,
    ),
    ...(source.authoredAt ? { authoredAt: source.authoredAt } : {}),
    importedAt: source.importedAt,
    verification: source.verification,
  };
}

/**
 * reads the label and facts for one projected resource, from allowlisted fields
 * @param resource the projected resource
 * @returns the label and the factual parts
 */
function describe(resource: ProjectedResource): {
  label: string;
  facts: string[];
} {
  const named = (prefix: string, value: ProjectedValue | undefined): string =>
    `${prefix}: ${conceptText(value) ?? resource.resourceType}`;

  switch (resource.resourceType) {
    case 'Patient':
      return { label: 'Patient', facts: patientFacts(resource) };
    case 'AllergyIntolerance':
      return {
        label: named('Allergy', resource.code),
        facts: [
          labelled('criticality', scalar(resource.criticality)),
          labelled('reaction', reactionText(resource.reaction)),
          labelled('clinical status', conceptText(resource.clinicalStatus)),
        ],
      };
    case 'MedicationStatement':
      return {
        label: named('Medication', resource.medicationCodeableConcept),
        facts: [
          labelled('status', scalar(resource.status)),
          scalar(field(first(resource.dosage), 'text')) ?? '',
          labelled('since', scalar(field(resource.effectivePeriod, 'start'))),
        ],
      };
    case 'Condition':
      return {
        label: named('Condition', resource.code),
        facts: [
          labelled('clinical status', conceptText(resource.clinicalStatus)),
          labelled('onset', scalar(resource.onsetDateTime)),
        ],
      };
    case 'Observation':
      return {
        label: named('Observation', resource.code),
        facts: observationFacts(resource),
      };
    case 'DiagnosticReport':
      return {
        label: named('Report', resource.code),
        facts: [
          scalar(resource.conclusion) ?? '',
          labelled('status', scalar(resource.status)),
        ],
      };
    case 'DocumentReference':
      return {
        label: named('Document', resource.type),
        facts: [scalar(resource.description) ?? ''],
      };
    default:
      return { label: 'Provenance', facts: provenanceFacts(resource) };
  }
}

/**
 * builds the facts of a projected Patient
 * @param resource a projected Patient
 * @returns name, gender and birth date
 */
function patientFacts(resource: ProjectedResource): string[] {
  const name = first(resource.name);
  const parts = ['prefix', 'given', 'family'].flatMap((key) =>
    asArray(field(name, key)).flatMap((part) => scalarList(part)),
  );

  return [
    parts.join(' '),
    labelled('gender', scalar(resource.gender)),
    labelled('born', scalar(resource.birthDate)),
  ];
}

/**
 * builds the facts of a projected Observation
 * @param resource a projected Observation
 * @returns the value or components, any absent reason, status and time
 */
function observationFacts(resource: ProjectedResource): string[] {
  const components = asArray(resource.component).map((component) =>
    `${conceptText(field(component, 'code')) ?? 'component'} ${quantityText(field(component, 'valueQuantity')) ?? ''}`.trim(),
  );

  return [
    quantityText(resource.valueQuantity) ?? '',
    components.join(', '),
    labelled('not available', conceptText(resource.dataAbsentReason)),
    labelled('status', scalar(resource.status)),
    labelled('effective', scalar(resource.effectiveDateTime)),
    labelled('note', scalar(field(first(resource.note), 'text'))),
  ];
}

/**
 * builds the facts of a projected Provenance
 * @param resource a projected Provenance
 * @returns the recorded time and its released targets
 */
function provenanceFacts(resource: ProjectedResource): string[] {
  const targets = asArray(resource.target).flatMap((target) =>
    scalarList(field(target, 'reference')),
  );

  return [
    labelled('recorded', scalar(resource.recorded)),
    labelled('targets', targets.join(', ') || undefined),
  ];
}

/**
 * formats the first reaction of an allergy as `manifestation (severity)`
 * @param value the projected `reaction`
 * @returns the text, if any
 */
function reactionText(value: ProjectedValue | undefined): string | undefined {
  const reaction = first(value);
  const manifestation = conceptText(field(reaction, 'manifestation'));
  const severity = scalar(field(reaction, 'severity'));

  if (!manifestation) {
    return undefined;
  }

  return severity ? `${manifestation} (${severity})` : manifestation;
}

/**
 * reads the display text of a CodeableConcept (or the first of a list)
 * @param value the projected concept
 * @returns its text, else the first coding's display or code
 */
function conceptText(value: ProjectedValue | undefined): string | undefined {
  const concept = first(value);
  const coding = first(field(concept, 'coding'));

  return (
    scalar(field(concept, 'text')) ??
    scalar(field(coding, 'display')) ??
    scalar(field(coding, 'code'))
  );
}

/**
 * formats a Quantity as `value unit`
 * @param value the projected quantity
 * @returns the text, if it has a value
 */
function quantityText(value: ProjectedValue | undefined): string | undefined {
  const amount = scalar(field(value, 'value'));
  const unit = scalar(field(value, 'unit')) ?? scalar(field(value, 'code'));

  if (amount === undefined) {
    return undefined;
  }

  return unit ? `${amount} ${unit}` : amount;
}

/**
 * formats `name value`, or empty when there is no value
 * @param name the fact name
 * @param value the fact value
 * @returns the fact text
 */
function labelled(name: string, value: string | undefined): string {
  return value === undefined ? '' : `${name} ${value}`;
}

/**
 * converts a scalar to text
 * @param value a projected value
 * @returns the text of a string, number or boolean; undefined otherwise
 */
function scalar(value: ProjectedValue | undefined): string | undefined {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? String(value)
    : undefined;
}

/**
 * lists the scalar texts of a value or list
 * @param value a projected value or list
 * @returns every scalar as text
 */
function scalarList(value: ProjectedValue | undefined): string[] {
  return asArray(value).flatMap((item) => {
    const text = scalar(item);

    return text === undefined ? [] : [text];
  });
}

/**
 * reads a field of a projected object
 * @param value a projected value
 * @param key the field name
 * @returns the field, or undefined when the value is not an object
 */
function field(
  value: ProjectedValue | undefined,
  key: string,
): ProjectedValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, ProjectedValue>>)[key]
    : undefined;
}

/**
 * reads the first element of a list, or the value itself
 * @param value a projected value or list
 * @returns the first element
 */
function first(value: ProjectedValue | undefined): ProjectedValue | undefined {
  return asArray(value)[0];
}

/**
 * converts a value to a list
 * @param value a projected value or list
 * @returns the list, a one-element list, or empty
 */
function asArray(value: ProjectedValue | undefined): readonly ProjectedValue[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? (value as readonly ProjectedValue[]) : [value];
}

/**
 * bounds a text to a length, marking a cut with an ellipsis
 * @param text any rendered text
 * @param max the maximum length in characters
 * @returns the text, cut to `max` with a trailing ellipsis when longer
 */
function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}${ELLIPSIS}`;
}
