/**
 * the deny-by-default policy decision (brief §5, §7 step 2), as pure
 * functions over plain data; it decides, for a verified clinician principal
 * and a clinical request, exactly which records may be released and under
 * which grant version, by wrapping the release predicate in
 * `src/contracts/grant.ts` (`isRecordReleasable` is the per-record verdict)
 *
 * nothing here reads a clock, a database or the request's prose: the server
 * resolves the registry entry and the encounter, and passes `now` in
 */
import {
  encounterAdmitsCaller,
  grantCoversRecord,
  granteeMatches,
  isGrantInForce,
  isRecordReleasable,
  RECORD_CATEGORIES,
  SCOPE_REQUEST,
} from '../contracts';

import { fieldAllowlistFor } from './fields';

import type {
  ClinicalRequest,
  ClinicianEntry,
  Encounter,
  Grant,
  GrantCaller,
  PersonRef,
  Principal,
  Purpose,
  RationaleCode,
  RecordCategory,
  RecordEnvelope,
} from '../contracts';

/**
 * the request fields policy reads; `encounterId` is a selector the server
 * resolves; the question text never influences a decision
 */
export type PolicyRequest = Pick<
  ClinicalRequest,
  'encounterId' | 'purpose' | 'requestedCategories'
>;

/** what policy knows about a record: labels only, never its body */
export type RecordLabel = Pick<
  RecordEnvelope,
  'id' | 'category' | 'resourceType' | 'sensitivity' | 'status'
>;

/** a deny rationale: every contract code that is not a release outcome */
export type DenyRationale = Exclude<
  RationaleCode,
  'granted' | 'duplicate-request' | 'selector-fallback'
>;

/** the exact grant version a record was released under */
export interface GrantVersion {
  id: string;
  version: number;
}

/** one record the decision releases */
export interface ReleasedRecordDecision {
  recordId: string;
  category: RecordCategory;
  grant: GrantVersion;
}

/** everything a decision is made from; all of it server-derived */
export interface PolicyInput {
  /** the principal derived from a verified access token */
  principal: Principal;
  /** the registry entry for `(principal.issuer, principal.subject)`, if any */
  clinician?: ClinicianEntry;
  request: PolicyRequest;
  /** the encounter the server read by `request.encounterId`, if any */
  encounter?: Encounter;
  /** the vault patient */
  patientId: string;
  /** the patient's grants; only the highest version of each id counts */
  grants: readonly Grant[];
  /** labels of every record of the patient */
  records: readonly RecordLabel[];
  /** the server clock */
  now: Date;
}

/** a release: which records, under which grant versions, and until when */
export interface PolicyAllow {
  effect: 'allow';
  rationaleCode: 'granted';
  policyVersion: string;
  decidedAt: string;
  patientId: string;
  encounterId: string;
  purpose: Purpose;
  /** the caller with registry organization and roles, never token claims */
  caller: GrantCaller;
  /** categories of the released records, in canonical order */
  approvedCategories: RecordCategory[];
  /** released records, in the order of `PolicyInput.records` */
  records: ReleasedRecordDecision[];
  /** the earliest end of the encounter and every grant relied on */
  expiresAt: string;
}

/**
 * a refusal; it carries a rationale code and nothing else, so it reveals
 * nothing about which records exist
 */
export interface PolicyDeny {
  effect: 'deny';
  rationaleCode: DenyRationale;
  policyVersion: string;
  decidedAt: string;
}

/** the outcome of a policy decision */
export type PolicyDecision = PolicyAllow | PolicyDeny;

/**
 * what a prior decision is re-checked against: the person bound to the task
 * and current state; no token is involved (a poll carries none), so the
 * request-scope check belongs to the original decision only
 */
export type RecheckInput = Omit<PolicyInput, 'request' | 'principal'> & {
  /** the verified issuer and subject bound to the task */
  caller: PersonRef;
};

/** the identity of the policy rules, recorded on every receipt */
export const POLICY_VERSION = 'medissy-policy/1';

/** the state a caller is admitted against, for a decision or a re-check */
type AdmitInput = Omit<PolicyInput, 'principal' | 'request'> & {
  person: PersonRef;
  encounterId: string;
};

/** a caller admitted to an encounter, with the grants that may apply */
interface Admission {
  caller: GrantCaller;
  encounter: Encounter;
  /** effective grants for this patient, encounter, purpose and caller */
  grants: Grant[];
}

/** a record the predicate releases and the allow grant that covers it */
interface Release {
  label: RecordLabel;
  grant: Grant;
}

/**
 * decides which records a verified clinician may receive for a request;
 * deny-by-default: anything short of an active registry entry, an admitting
 * encounter and an in-force allow grant covering at least one current,
 * projectable record is a deny
 * @param input the principal, registry entry, request, encounter, grants,
 * record labels and clock
 * @returns an allow naming each record and grant version, or a bare deny
 */
export function decide(input: PolicyInput): PolicyDecision {
  const { principal, request, ...state } = input;

  if (!principal.scopes.includes(SCOPE_REQUEST)) {
    return deny('insufficient-scope', input.now);
  }

  const admission = admit({
    ...state,
    person: principal,
    encounterId: request.encounterId,
  });

  if ('rationaleCode' in admission) {
    return deny(admission.rationaleCode, input.now);
  }

  const releases = selectReleases(
    input,
    admission,
    request.requestedCategories,
  );

  return releases.length > 0
    ? allow(input, admission, releases)
    : deny(emptyRationale(admission.grants, input.now), input.now);
}

/**
 * re-checks a prior allow against the current time, registry, encounter and
 * grant state, as every later use must (retrieval, release, poll); the result
 * never widens the prior decision: it keeps only prior records that are still
 * releasable now, under their current grant versions
 * @param prior the allow decision being relied on
 * @param input current state, read again at the moment of use
 * @returns the narrowed allow, or a deny when nothing remains
 */
export function recheckDecision(
  prior: PolicyAllow,
  input: RecheckInput,
): PolicyDecision {
  const { caller, ...state } = input;
  const sameCaller =
    caller.issuer === prior.caller.issuer &&
    caller.subject === prior.caller.subject;

  if (!sameCaller || input.patientId !== prior.patientId) {
    return deny('principal-not-registered', input.now);
  }

  const admission = admit({
    ...state,
    person: caller,
    encounterId: prior.encounterId,
  });

  if ('rationaleCode' in admission) {
    return deny(admission.rationaleCode, input.now);
  }

  const priorIds = new Set(prior.records.map((record) => record.recordId));
  const releases = selectReleases(input, admission).filter((release) =>
    priorIds.has(release.label.id),
  );

  if (releases.length > 0) {
    return allow(input, admission, releases);
  }

  const priorGrantIds = new Set(prior.records.map((record) => record.grant.id));
  const reliedOn = admission.grants.filter((grant) =>
    priorGrantIds.has(grant.id),
  );

  return deny(emptyRationale(reliedOn, input.now), input.now);
}

/**
 * checks steps 1 and 2 of the release predicate: the person is an active registered
 * clinician, and the encounter the server read by the selector admits them
 * now
 * @param input the person, the selector and the state read for them
 * @returns the admission, or the rationale for refusing it
 */
function admit(
  input: AdmitInput,
): Admission | { rationaleCode: DenyRationale } {
  const { person, encounterId, encounter, patientId, now } = input;
  const caller = registeredCaller(person, input.clinician);

  if (!caller) {
    return { rationaleCode: 'principal-not-registered' };
  }

  // an unknown id, another patient's encounter and an encounter the caller is
  // not linked to get the same code, so the selector is not an oracle. PURPOSES
  // has one value today; when it grows, also require request.purpose to equal
  // encounter.purpose here (rationale `encounter-mismatch`)
  if (
    encounter?.id !== encounterId ||
    encounter.patientId !== patientId ||
    !encounterAdmitsCaller(encounter, caller, now)
  ) {
    return { rationaleCode: 'encounter-not-found' };
  }

  const grants = effectiveGrants(input.grants).filter(
    (grant) =>
      grant.patientId === patientId &&
      grant.encounterId === encounter.id &&
      granteeMatches(grant.grantee, caller),
  );

  return { caller, encounter, grants };
}

/**
 * builds the caller as policy sees it: identity from the verified sign-in,
 * organization and roles from the registry entry only, which the verified
 * institution sign-in wrote (ADR-9); token claims are never read here
 * @param person the verified issuer and subject
 * @param entry the registry entry looked up for the person
 * @returns the caller, or undefined unless the entry is the person's, active and holds a
 * clinical role
 */
function registeredCaller(
  person: PersonRef,
  entry: ClinicianEntry | undefined,
): GrantCaller | undefined {
  // an entry whose institution no longer names a clinical role is unknown
  if (
    entry?.status !== 'active' ||
    entry.issuer !== person.issuer ||
    entry.subject !== person.subject ||
    entry.roles.length === 0
  ) {
    return undefined;
  }

  return {
    issuer: entry.issuer,
    subject: entry.subject,
    organizationId: entry.organizationId,
    roles: [...entry.roles],
  };
}

/**
 * selects the highest version of each grant id; only it is effective (release predicate
 * step 3): an older, unrevoked version never outlives its revocation
 * @param grants grant rows, possibly several versions per id
 * @returns one grant per id, the highest version, ordered by id
 */
function effectiveGrants(grants: readonly Grant[]): Grant[] {
  const latest = new Map<string, Grant>();

  for (const grant of grants) {
    const seen = latest.get(grant.id);

    if (!seen || grant.version > seen.version) {
      latest.set(grant.id, grant);
    }
  }

  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * selects the records the predicate releases, each with the allow grant (lowest id)
 * that covers it; only current records with a field allowlist are eligible
 * @param input the record labels and clock reading
 * @param admission the admitted caller, encounter and applicable grants
 * @param requestedCategories the request's optional narrowing
 * @returns the releases, in record order
 */
function selectReleases(
  input: Pick<PolicyInput, 'records' | 'now'>,
  admission: Admission,
  requestedCategories?: readonly RecordCategory[],
): Release[] {
  const { caller, encounter, grants } = admission;
  const { now } = input;

  return input.records.flatMap((label): Release[] => {
    if (
      label.status !== 'current' ||
      !fieldAllowlistFor(label.category, label.resourceType) ||
      !isRecordReleasable({
        grants,
        caller,
        encounter,
        now,
        record: label,
        requestedCategories,
      })
    ) {
      return [];
    }

    const grant = grants.find(
      (candidate) =>
        candidate.effect === 'allow' &&
        isGrantInForce(candidate, now) &&
        grantCoversRecord(candidate, label),
    );

    return grant ? [{ label, grant }] : [];
  });
}

/**
 * derives why nothing was released from grant state alone, so the code never
 * depends on which records exist
 * @param grants the applicable effective grants
 * @param now the server clock
 * @returns the deny rationale
 */
function emptyRationale(grants: readonly Grant[], now: Date): DenyRationale {
  const inForce = grants.filter((grant) => isGrantInForce(grant, now));
  const allows = grants.filter((grant) => grant.effect === 'allow');
  const at = now.getTime();

  if (inForce.some((grant) => grant.effect === 'allow')) {
    return inForce.some((grant) => grant.effect === 'deny')
      ? 'denied-by-deny-grant'
      : 'category-not-permitted';
  }

  if (allows.some((grant) => grant.revokedAt !== undefined)) {
    return 'grant-revoked';
  }

  if (allows.some((grant) => Date.parse(grant.expiresAt) <= at)) {
    return 'grant-expired';
  }

  if (allows.some((grant) => at < Date.parse(grant.validFrom))) {
    return 'grant-not-yet-valid';
  }

  return 'no-grant';
}

/**
 * builds an allow decision from the selected releases
 * @param input the decision input
 * @param admission the admitted caller and encounter
 * @param releases the non-empty releases
 * @returns the allow decision
 */
function allow(
  input: Pick<PolicyInput, 'now' | 'patientId'>,
  admission: Admission,
  releases: readonly Release[],
): PolicyAllow {
  const { caller, encounter } = admission;
  const released = new Set(releases.map(({ label }) => label.category));
  const ends = [
    encounter.endsAt,
    ...releases.map(({ grant }) => grant.expiresAt),
  ].map((value) => Date.parse(value));

  return {
    effect: 'allow',
    rationaleCode: 'granted',
    policyVersion: POLICY_VERSION,
    decidedAt: input.now.toISOString(),
    patientId: input.patientId,
    encounterId: encounter.id,
    purpose: encounter.purpose,
    caller,
    approvedCategories: RECORD_CATEGORIES.filter((category) =>
      released.has(category),
    ),
    records: releases.map(({ label, grant }) => ({
      recordId: label.id,
      category: label.category,
      grant: { id: grant.id, version: grant.version },
    })),
    expiresAt: new Date(Math.min(...ends)).toISOString(),
  };
}

/**
 * builds a deny decision
 * @param rationaleCode the contract rationale
 * @param now the server clock
 * @returns the deny decision
 */
function deny(rationaleCode: DenyRationale, now: Date): PolicyDeny {
  return {
    effect: 'deny',
    rationaleCode,
    policyVersion: POLICY_VERSION,
    decidedAt: now.toISOString(),
  };
}
