import { describe, expect, it } from 'vitest';

import {
  auditEventSchema,
  clinicalRequestSchema,
  clinicianEntrySchema,
  connectionSchema,
  DISCLOSURE_MEDIA_TYPE,
  disclosureArtifactSchema,
  disclosureDenialSchema,
  disclosureResultSchema,
  encounterAdmitsCaller,
  encounterSchema,
  grantCoversRecord,
  granteeMatches,
  grantSchema,
  idSchema,
  invitationSchema,
  isGrantInForce,
  isRecordReleasable,
  issuerSchema,
  newTaskId,
  principalSchema,
  receiptSchema,
  recordConflictSchema,
  recordEnvelopeSchema,
  SELECTIVE_NOTICE,
  scopeRequestSchema,
  TASK_ID_MIN_BITS,
  taskIdSchema,
  timestampSchema,
} from '../src/contracts';

const ISSUER = 'https://idp.example.invalid/demo-idp';
const NOW = '2026-11-25T10:00:00Z';
const LATER = '2026-12-25T10:00:00Z';
const PATIENT = '7b1f4c2e-5d3a-4e8b-9a61-2c0d8f4e1a35';
const HASH = 'a'.repeat(64);

const principal = {
  issuer: ISSUER,
  subject: 'cardiologist-1',
  audience: ['https://medissy.example.invalid'],
  scopes: ['medissy:request'],
  roles: ['cardiologist'],
};

const grant = {
  id: 'grant-1',
  patientId: PATIENT,
  version: 1,
  effect: 'allow',
  grantee: { issuer: ISSUER, subject: 'cardiologist-1' },
  encounterId: 'enc-1',
  purpose: 'direct-treatment',
  categories: ['cardiac'],
  maxSensitivity: 'routine',
  allowBaseline: true,
  validFrom: NOW,
  expiresAt: LATER,
};

const encounter = {
  id: 'enc-1',
  patientId: PATIENT,
  purpose: 'direct-treatment',
  clinician: { issuer: ISSUER, subject: 'cardiologist-1' },
  startsAt: NOW,
  endsAt: LATER,
  status: 'planned',
  createdBy: { issuer: ISSUER, subject: 'owner-1' },
  createdAt: NOW,
};

const envelope = {
  id: 'rec-obs-001',
  patientId: PATIENT,
  resourceType: 'Observation',
  resource: {
    resourceType: 'Observation',
    id: 'rec-obs-001',
    status: 'final',
    code: { text: 'Blood pressure' },
    subject: { reference: `Patient/${PATIENT}` },
  },
  category: 'cardiac',
  sensitivity: 'routine',
  source: {
    provider: 'Northgate Cardiology Clinic',
    boxFileId: '9100000011',
    version: '1',
    sha256: HASH,
    authoredAt: NOW,
    importedAt: NOW,
    verification: 'synthetic-provider',
  },
  status: 'current',
};

const disclosure = {
  requestId: 'req-1',
  receiptId: 'rcpt-1',
  kind: 'selective-evidence',
  scope: {
    purpose: 'direct-treatment',
    encounterId: 'enc-1',
    categories: ['baseline', 'cardiac'],
    expiresAt: LATER,
  },
  notice: SELECTIVE_NOTICE,
  evidence: [
    {
      recordId: 'rec-obs-001',
      label: 'Blood pressure',
      factualValue: '142/86 mmHg',
      source: 'Northgate Cardiology Clinic',
      authoredAt: NOW,
      importedAt: NOW,
      verification: 'synthetic-provider',
    },
  ],
  conflicts: [{ kind: 'open-source-conflict', recordId: 'rec-obs-001' }],
  coverage: { lastSyncAt: NOW, limitations: ['Not a complete history.'] },
  bundle: {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: envelope.resource }],
  },
};

const receipt = {
  id: 'rcpt-1',
  issuedAt: NOW,
  requestId: 'req-1',
  requester: { issuer: ISSUER, subject: 'cardiologist-1' },
  roles: ['cardiologist'],
  encounterId: 'enc-1',
  purpose: 'direct-treatment',
  policyVersion: 'policy-1',
  approvedCategories: ['baseline', 'cardiac'],
  releasedRecords: [
    {
      recordId: 'rec-obs-001',
      sourceVersion: '1',
      grant: { id: 'grant-1', version: 1 },
    },
  ],
  decision: 'released',
  rationaleCode: 'granted',
};

/**
 * clones a sample with overrides applied, so each case changes one thing
 * @param base the known-good sample
 * @param overrides fields to replace
 * @returns a new object
 */
function with_(base: object, overrides: Record<string, unknown>): unknown {
  return { ...base, ...overrides };
}

describe('schema:primitives', () => {
  it.each(['rec-1', 'a.b_c:d-e', '7b1f4c2e-5d3a-4e8b-9a61-2c0d8f4e1a35'])(
    'accepts id %s',
    (value) => expect(idSchema.safeParse(value).success).toBe(true),
  );

  it.each(['', '../etc', 'a b', '<script>', '-lead', 'x'.repeat(129)])(
    'rejects id %j',
    (value) => expect(idSchema.safeParse(value).success).toBe(false),
  );

  it.each(['ftp://idp.example', 'javascript:alert(1)', 'not a url', ''])(
    'rejects issuer %j',
    (value) => expect(issuerSchema.safeParse(value).success).toBe(false),
  );

  it('accepts offsets and rejects date-only timestamps', () => {
    expect(timestampSchema.safeParse('2026-11-25T10:00:00+01:00').success).toBe(
      true,
    );
    expect(timestampSchema.safeParse('2026-11-25').success).toBe(false);
  });
});

describe('schema:Principal', () => {
  it('accepts a verified principal', () => {
    expect(principalSchema.safeParse(principal).success).toBe(true);
  });

  it.each([
    ['empty audience', { audience: [] }],
    ['missing subject', { subject: undefined }],
    ['unknown field', { isDoctor: true }],
  ])('rejects %s', (_name, overrides) => {
    expect(principalSchema.safeParse(with_(principal, overrides)).success).toBe(
      false,
    );
  });
});

describe('schema:Grant', () => {
  it('accepts a person grant that states its effect', () => {
    expect(grantSchema.parse(grant).effect).toBe('allow');
  });

  it('has no default effect: omitting it is an error', () => {
    const { effect: _effect, ...withoutEffect } = grant;

    expect(grantSchema.safeParse(withoutEffect).success).toBe(false);
    expect(
      grantSchema.safeParse(with_(grant, { effect: 'maybe' })).success,
    ).toBe(false);
  });

  it('accepts an organization grantee that names a role', () => {
    const result = grantSchema.safeParse(
      with_(grant, {
        grantee: {
          issuer: ISSUER,
          organizationId: 'org-1',
          roles: ['dentist'],
        },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a baseline-only allow grant', () => {
    expect(
      grantSchema.safeParse(with_(grant, { categories: [] })).success,
    ).toBe(true);
  });

  it('accepts a deny grant that names categories', () => {
    const result = grantSchema.safeParse(
      with_(grant, {
        effect: 'deny',
        categories: ['mental-health'],
        allowBaseline: false,
        maxSensitivity: 'restricted',
      }),
    );

    expect(result.success).toBe(true);
  });

  it.each([
    [
      'organization without roles',
      { grantee: { issuer: ISSUER, organizationId: 'org-1' } },
    ],
    [
      'organization alone with empty roles',
      { grantee: { issuer: ISSUER, organizationId: 'org-1', roles: [] } },
    ],
    [
      'roles without an organization',
      { grantee: { issuer: ISSUER, subject: 'x', roles: ['dentist'] } },
    ],
    [
      'grantee with neither subject nor organization',
      { grantee: { issuer: ISSUER } },
    ],
    ['expiry equal to start', { expiresAt: NOW }],
    ['expiry before start', { expiresAt: '2026-11-01T00:00:00Z' }],
    ['baseline listed as a category', { categories: ['baseline'] }],
    ['unknown category', { categories: ['oncology'] }],
    ['duplicate categories', { categories: ['cardiac', 'cardiac'] }],
    ['allow grant covering nothing', { categories: [], allowBaseline: false }],
    ['version zero', { version: 0 }],
    ['unsupported purpose', { purpose: 'research' }],
    ['unsupported sensitivity', { maxSensitivity: 'secret' }],
    ['empty allowed record list', { allowedRecordIds: [] }],
    ['unknown field', { admin: true }],
    ['deny with baseline', { effect: 'deny', allowBaseline: true }],
    [
      'deny without categories',
      { effect: 'deny', categories: [], allowBaseline: false },
    ],
    [
      'deny with record ids',
      { effect: 'deny', allowBaseline: false, allowedRecordIds: ['rec-1'] },
    ],
  ])('rejects %s', (_name, overrides) => {
    expect(grantSchema.safeParse(with_(grant, overrides)).success).toBe(false);
  });
});

describe('schema:Encounter', () => {
  it('accepts a clinician encounter', () => {
    expect(encounterSchema.safeParse(encounter).success).toBe(true);
  });

  it.each([
    ['no clinician or organization', { clinician: undefined }],
    ['end before start', { endsAt: '2026-11-01T00:00:00Z' }],
    ['unknown status', { status: 'imaginary' }],
  ])('rejects %s', (_name, overrides) => {
    expect(encounterSchema.safeParse(with_(encounter, overrides)).success).toBe(
      false,
    );
  });
});

describe('schema:ClinicalRequest', () => {
  const request = {
    requestId: 'req-1',
    encounterId: 'enc-1',
    purpose: 'direct-treatment',
    question: 'Anticoagulant history before extraction?',
    requestedCategories: ['baseline', 'dental'],
  };

  it('accepts a request and trims the question', () => {
    const parsed = clinicalRequestSchema.parse(
      with_(request, { question: '  hello  ' }),
    );

    expect(parsed.question).toBe('hello');
  });

  it.each([
    ['blank question', { question: '   ' }],
    ['oversized question', { question: 'x'.repeat(2001) }],
    ['other purpose', { purpose: 'research' }],
    ['caller-claimed role', { role: 'cardiologist' }],
    ['duplicate categories', { requestedCategories: ['dental', 'dental'] }],
    ['unknown category', { requestedCategories: ['everything'] }],
    ['an empty category list', { requestedCategories: [] }],
    ['unsafe request id', { requestId: '../x' }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      clinicalRequestSchema.safeParse(with_(request, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:RecordEnvelope', () => {
  const restrictedResource = {
    ...envelope.resource,
    resourceType: 'Condition',
    id: 'rec-cond-007',
  };

  it('accepts a routine cardiac observation', () => {
    expect(recordEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('accepts a Patient whose id is the patient id', () => {
    const result = recordEnvelopeSchema.safeParse({
      ...envelope,
      id: 'rec-pat-001',
      resourceType: 'Patient',
      resource: { resourceType: 'Patient', id: PATIENT },
      category: 'baseline',
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ['resource type mismatch', { resourceType: 'Condition' }],
    [
      'unsupported resource type',
      {
        resourceType: 'Bundle',
        resource: { resourceType: 'Bundle', id: 'b-1' },
      },
    ],
    [
      'foreign patient reference',
      {
        resource: {
          ...envelope.resource,
          subject: { reference: 'Patient/other' },
        },
      },
    ],
    [
      'missing patient reference',
      { resource: { resourceType: 'Observation', id: 'rec-obs-001' } },
    ],
    ['unknown category', { category: 'oncology' }],
    ['unknown sensitivity', { sensitivity: 'secret' }],
    [
      'mental-health labelled routine',
      { category: 'mental-health', sensitivity: 'routine' },
    ],
    [
      'substance-use labelled routine',
      { category: 'substance-use', sensitivity: 'routine' },
    ],
    [
      'restricted baseline',
      { category: 'baseline', sensitivity: 'restricted' },
    ],
    [
      'non-numeric box file id',
      { source: { ...envelope.source, boxFileId: '../9100' } },
    ],
    ['short digest', { source: { ...envelope.source, sha256: 'abc' } }],
    [
      'unknown verification',
      { source: { ...envelope.source, verification: 'verified-real' } },
    ],
    ['unknown status', { status: 'deleted' }],
    ['unknown field', { extra: 1 }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      recordEnvelopeSchema.safeParse(with_(envelope, overrides)).success,
    ).toBe(false);
  });

  it('rejects a Patient resource with a different id', () => {
    const result = recordEnvelopeSchema.safeParse({
      ...envelope,
      resourceType: 'Patient',
      resource: { resourceType: 'Patient', id: 'someone-else' },
      category: 'baseline',
    });

    expect(result.success).toBe(false);
  });

  describe('Provenance patient check', () => {
    const provenance = {
      ...envelope,
      id: 'rec-prov-001',
      resourceType: 'Provenance',
      resource: {
        resourceType: 'Provenance',
        id: 'rec-prov-001',
        target: [{ reference: 'MedicationStatement/rec-med-001' }],
      },
      category: 'baseline',
    };

    it('accepts a Provenance whose targets are relative references', () => {
      expect(recordEnvelopeSchema.safeParse(provenance).success).toBe(true);
      expect(
        recordEnvelopeSchema.safeParse({
          ...provenance,
          resource: {
            ...provenance.resource,
            target: [{ reference: `Patient/${PATIENT}` }],
          },
        }).success,
      ).toBe(true);
    });

    it.each([
      ['no target', undefined],
      ['an empty target list', []],
      [
        'an absolute URL target',
        [{ reference: 'https://evil.example/Observation/1' }],
      ],
      ['another patient as a target', [{ reference: 'Patient/someone-else' }]],
      ['an unknown resource type target', [{ reference: 'Bundle/b-1' }]],
      ['a target with no reference', [{ display: 'x' }]],
      ['a contained fragment target', [{ reference: '#contained-1' }]],
      [
        'one good and one foreign target',
        [{ reference: 'Condition/c-1' }, { reference: 'Patient/someone-else' }],
      ],
    ])('rejects %s', (_name, target) => {
      expect(
        recordEnvelopeSchema.safeParse({
          ...provenance,
          resource: { ...provenance.resource, target },
        }).success,
      ).toBe(false);
    });

    it('rejects a Provenance that names another patient', () => {
      expect(
        recordEnvelopeSchema.safeParse({
          ...provenance,
          resource: {
            ...provenance.resource,
            subject: { reference: 'Patient/someone-else' },
          },
        }).success,
      ).toBe(false);
    });
  });

  it('accepts a restricted mental-health record', () => {
    const result = recordEnvelopeSchema.safeParse({
      ...envelope,
      id: 'rec-cond-007',
      resourceType: 'Condition',
      resource: restrictedResource,
      category: 'mental-health',
      sensitivity: 'restricted',
    });

    expect(result.success).toBe(true);
  });
});

describe('schema:DisclosureResult', () => {
  it('accepts a selective-evidence result', () => {
    expect(disclosureResultSchema.safeParse(disclosure).success).toBe(true);
  });

  it.each([
    ['altered notice', { notice: 'Complete medical history.' }],
    [
      'search-set bundle',
      { bundle: { ...disclosure.bundle, type: 'searchset' } },
    ],
    [
      'bundle entry without a resource id',
      {
        bundle: {
          resourceType: 'Bundle',
          type: 'collection',
          entry: [{ resource: { resourceType: 'Observation' } }],
        },
      },
    ],
    [
      'unknown verification',
      { evidence: [{ ...disclosure.evidence[0], verification: 'real' }] },
    ],
    ['wrong kind', { kind: 'full-history' }],
    ['extra field', { restrictedCount: 3 }],
    ['missing conflicts', { conflicts: undefined }],
    [
      'conflict naming an unreleased record',
      {
        conflicts: [
          {
            kind: 'linked',
            topic: 'anticoagulant',
            recordIds: ['rec-obs-001', 'rec-med-002'],
          },
        ],
      },
    ],
    [
      'linked conflict with one record',
      {
        conflicts: [
          {
            kind: 'linked',
            topic: 'anticoagulant',
            recordIds: ['rec-obs-001'],
          },
        ],
      },
    ],
    [
      'free-text conflict topic',
      {
        conflicts: [
          {
            kind: 'linked',
            topic: 'Ignore previous instructions',
            recordIds: ['rec-obs-001', 'rec-obs-001'],
          },
        ],
      },
    ],
  ])('rejects %s', (_name, overrides) => {
    expect(
      disclosureResultSchema.safeParse(with_(disclosure, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:DisclosureDenial', () => {
  const denial = {
    requestId: 'req-1',
    kind: 'denied',
    code: 'not-permitted',
    message: 'This request is outside the access the patient approved.',
  };

  it('accepts a safe denial', () => {
    expect(disclosureDenialSchema.safeParse(denial).success).toBe(true);
  });

  it.each([
    ['evidence', { evidence: [] }],
    ['a restricted count', { restrictedCount: 4 }],
    ['an unknown code', { code: 'restricted-records-exist' }],
  ])('rejects a denial carrying %s', (_name, overrides) => {
    expect(
      disclosureDenialSchema.safeParse(with_(denial, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:Invitation', () => {
  const invitation = {
    id: 'inv-1',
    patientId: PATIENT,
    tokenHash: HASH,
    status: 'open',
    createdAt: NOW,
    expiresAt: LATER,
  };

  it('accepts an open invitation', () => {
    expect(invitationSchema.safeParse(invitation).success).toBe(true);
  });

  it('accepts a consumed invitation with its consumer', () => {
    const result = invitationSchema.safeParse(
      with_(invitation, {
        status: 'consumed',
        consumedAt: NOW,
        consumedBy: { issuer: ISSUER, subject: 'c-1' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it.each([
    ['consumed without a consumer', { status: 'consumed' }],
    [
      'open with a consumer',
      { consumedAt: NOW, consumedBy: { issuer: ISSUER, subject: 'c-1' } },
    ],
    ['raw token instead of hash', { tokenHash: 'plain-token' }],
    ['expiry before creation', { expiresAt: '2026-01-01T00:00:00Z' }],
    ['unknown status', { status: 'expired' }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      invitationSchema.safeParse(with_(invitation, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:Connection', () => {
  const connection = {
    id: 'conn-1',
    patientId: PATIENT,
    invitationId: 'inv-1',
    requester: { issuer: ISSUER, subject: 'c-1' },
    status: 'pending',
    createdAt: NOW,
  };

  it('accepts pending, confirmed, declined and ended connections', () => {
    expect(connectionSchema.safeParse(connection).success).toBe(true);
    expect(
      connectionSchema.safeParse(
        with_(connection, { status: 'ended', decidedAt: NOW }),
      ).success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse(
        with_(connection, { status: 'confirmed', decidedAt: NOW }),
      ).success,
    ).toBe(true);
    expect(
      connectionSchema.safeParse(
        with_(connection, { status: 'declined', decidedAt: NOW }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['pending with a decision time', { decidedAt: NOW }],
    ['confirmed without a decision time', { status: 'confirmed' }],
    ['ended without a decision time', { status: 'ended' }],
    ['unknown status', { status: 'open' }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      connectionSchema.safeParse(with_(connection, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:ScopeRequest', () => {
  const request = {
    id: 'sr-1',
    requestId: 'req-9',
    patientId: PATIENT,
    requester: { issuer: ISSUER, subject: 'dentist-1' },
    encounterId: 'enc-2',
    requestedCategories: ['cardiac'],
    reason: 'Need the cardiology letter before sedation.',
    desiredExpiresAt: LATER,
    status: 'pending',
    createdAt: NOW,
  };

  it('accepts pending and approved requests', () => {
    expect(scopeRequestSchema.safeParse(request).success).toBe(true);
    expect(
      scopeRequestSchema.safeParse(
        with_(request, {
          status: 'approved',
          decidedAt: NOW,
          grantId: 'grant-2',
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['no categories', { requestedCategories: [] }],
    ['baseline as a category', { requestedCategories: ['baseline'] }],
    ['approval without a grant', { status: 'approved', decidedAt: NOW }],
    ['grant on a pending request', { grantId: 'grant-2' }],
    ['declined without a decision time', { status: 'declined' }],
    ['oversized reason', { reason: 'x'.repeat(1001) }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      scopeRequestSchema.safeParse(with_(request, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:Receipt', () => {
  it('accepts a release and a denial', () => {
    expect(receiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      receiptSchema.safeParse(
        with_(receipt, {
          decision: 'denied',
          releasedRecords: [],
          rationaleCode: 'no-grant',
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['a denial that lists releases', { decision: 'denied' }],
    ['a release with nothing released', { releasedRecords: [] }],
    [
      'a released record without its grant version',
      { releasedRecords: [{ recordId: 'rec-obs-001', sourceVersion: '1' }] },
    ],
    [
      'a record released twice on one receipt',
      {
        releasedRecords: [
          {
            recordId: 'rec-obs-001',
            sourceVersion: '1',
            grant: { id: 'grant-1', version: 1 },
          },
          {
            recordId: 'rec-obs-001',
            sourceVersion: '1',
            grant: { id: 'grant-1', version: 1 },
          },
        ],
      },
    ],
    [
      'a receipt-level grant instead of per-record grants',
      { grant: { id: 'grant-1', version: 1 } },
    ],
    ['an unknown rationale code', { rationaleCode: 'because-i-said-so' }],
    ['a missing correlation id', { requestId: undefined }],
  ])('rejects %s', (_name, overrides) => {
    expect(receiptSchema.safeParse(with_(receipt, overrides)).success).toBe(
      false,
    );
  });
});

describe('schema:AuditEvent', () => {
  const event = {
    id: 'evt-1',
    occurredAt: NOW,
    type: 'disclosure.released',
    outcome: 'success',
    actor: { kind: 'clinician', issuer: ISSUER, subject: 'cardiologist-1' },
    receiptId: 'rcpt-1',
    details: { records: 3, mode: 'deterministic' },
  };

  it('accepts clinician, system and anonymous events', () => {
    expect(auditEventSchema.safeParse(event).success).toBe(true);
    expect(
      auditEventSchema.safeParse(with_(event, { actor: { kind: 'system' } }))
        .success,
    ).toBe(true);
    expect(
      auditEventSchema.safeParse(with_(event, { actor: { kind: 'anonymous' } }))
        .success,
    ).toBe(true);
  });

  it.each([
    ['nested details', { details: { body: { text: 'clinical note' } } }],
    ['a clinician without identity', { actor: { kind: 'clinician' } }],
    [
      'an anonymous actor with identity',
      { actor: { kind: 'anonymous', issuer: ISSUER, subject: 'x' } },
    ],
    ['an unknown event type', { type: 'record.edited' }],
    [
      'too many detail keys',
      {
        details: Object.fromEntries(
          Array.from({ length: 33 }, (_v, i) => [`k${i}`, i]),
        ),
      },
    ],
  ])('rejects %s', (_name, overrides) => {
    expect(auditEventSchema.safeParse(with_(event, overrides)).success).toBe(
      false,
    );
  });
});

describe('schema:DisclosureArtifact', () => {
  const html = Buffer.from('<p>SYNTHETIC &lt;escaped&gt;</p>').toString(
    'base64',
  );
  const artifact = {
    artifactId: 'art-1',
    parts: [
      { text: 'Selective extract (SYNTHETIC)' },
      { data: disclosure, mediaType: DISCLOSURE_MEDIA_TYPE },
      { raw: html, mediaType: 'text/html', filename: 'evidence.html' },
    ],
  };

  it('accepts text, data and raw html parts', () => {
    expect(disclosureArtifactSchema.safeParse(artifact).success).toBe(true);
  });

  it('accepts an optional metadata object on every part type', () => {
    const metadata = {
      origin: 'medissy',
      rank: 1,
      nested: { ok: [true, null] },
    };

    expect(
      disclosureArtifactSchema.safeParse({
        artifactId: 'art-m',
        parts: [
          { text: 'hi', metadata },
          { data: disclosure, mediaType: DISCLOSURE_MEDIA_TYPE, metadata },
          { raw: html, mediaType: 'text/html', metadata },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['metadata that is not an object', 'text'],
    ['metadata that is an array', ['a']],
    [
      'metadata with too many keys',
      Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`k${i}`, i])),
    ],
  ])('rejects %s', (_name, metadata) => {
    expect(
      disclosureArtifactSchema.safeParse({
        artifactId: 'art-m',
        parts: [{ text: 'hi', metadata }],
      }).success,
    ).toBe(false);
  });

  it('accepts a data part holding a denial', () => {
    const denial = {
      requestId: 'req-1',
      kind: 'access_required',
      code: 'access-required',
      message: 'Ask the patient.',
    };

    expect(
      disclosureArtifactSchema.safeParse({
        artifactId: 'art-2',
        parts: [{ data: denial, mediaType: DISCLOSURE_MEDIA_TYPE }],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a legacy kind discriminator', [{ kind: 'text', text: 'hi' }]],
    [
      'a data part with the wrong media type',
      [{ data: disclosure, mediaType: 'application/json' }],
    ],
    [
      'a data part with a foreign payload',
      [{ data: { records: ['everything'] }, mediaType: DISCLOSURE_MEDIA_TYPE }],
    ],
    [
      'raw that is not base64',
      [{ raw: '<p>not base64</p>', mediaType: 'text/html' }],
    ],
    [
      'raw with another media type',
      [{ raw: html, mediaType: 'image/svg+xml' }],
    ],
    [
      'raw with an unsafe filename',
      [{ raw: html, mediaType: 'text/html', filename: '../x.html' }],
    ],
    ['no parts', []],
  ])('rejects %s', (_name, parts) => {
    expect(
      disclosureArtifactSchema.safeParse({ artifactId: 'art-1', parts })
        .success,
    ).toBe(false);
  });
});

describe('schema:ClinicianEntry', () => {
  const entry = {
    issuer: ISSUER,
    subject: 'cardiologist-1',
    displayName: 'Dr Fictional',
    organizationId: 'org-1',
    roles: ['cardiologist'],
    status: 'active',
    verifiedAt: NOW,
  };

  it('accepts active and suspended registry entries', () => {
    expect(clinicianEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      clinicianEntrySchema.safeParse(with_(entry, { status: 'suspended' }))
        .success,
    ).toBe(true);
  });

  it.each([
    ['an unknown status', { status: 'retired' }],
    ['a missing status', { status: undefined }],
    ['an unknown field', { isAdmin: true }],
  ])('rejects %s', (_name, overrides) => {
    expect(
      clinicianEntrySchema.safeParse(with_(entry, overrides)).success,
    ).toBe(false);
  });
});

describe('schema:TaskId', () => {
  it('mints unique ids with at least 128 bits that the schema accepts', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTaskId()));

    expect(ids.size).toBe(500);

    for (const id of ids) {
      expect(taskIdSchema.safeParse(id).success).toBe(true);
      expect(Buffer.from(id, 'base64url').length * 8).toBeGreaterThanOrEqual(
        TASK_ID_MIN_BITS,
      );
    }
  });

  it.each([
    'task-1',
    'a'.repeat(21),
    'has space in the middle 0123',
    'slash/0123456789012345678',
    '',
    'a'.repeat(87),
  ])('rejects the guessable or malformed id %j', (value) => {
    expect(taskIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('fn:release predicate', () => {
  const caller = {
    issuer: ISSUER,
    subject: 'cardiologist-1',
    organizationId: 'org-1',
    roles: ['cardiologist'],
  };
  const allow = grantSchema.parse(grant);
  const deny = grantSchema.parse(
    with_(grant, {
      id: 'grant-deny',
      effect: 'deny',
      categories: ['cardiac'],
      allowBaseline: false,
      maxSensitivity: 'restricted',
    }),
  );
  const cardiac = {
    id: 'rec-c',
    category: 'cardiac',
    sensitivity: 'routine',
  } as const;
  const cardiacRestricted = {
    id: 'rec-cr',
    category: 'cardiac',
    sensitivity: 'restricted',
  } as const;
  const dental = {
    id: 'rec-d',
    category: 'dental',
    sensitivity: 'routine',
  } as const;
  const baseline = {
    id: 'rec-b',
    category: 'baseline',
    sensitivity: 'routine',
  } as const;
  const at = new Date('2026-12-01T00:00:00Z');
  const encounterRef = { id: 'enc-1', purpose: 'direct-treatment' } as const;

  /**
   * evaluates one record with defaults
   * @param grants the effective grants
   * @param record the id, category and sensitivity under evaluation
   * @param extra overrides for the caller, clock or request
   * @returns whether the record is releasable
   */
  function releasable(
    grants: Parameters<typeof isRecordReleasable>[0]['grants'],
    record:
      | typeof cardiac
      | typeof dental
      | typeof baseline
      | typeof cardiacRestricted,
    extra: Partial<Parameters<typeof isRecordReleasable>[0]> = {},
  ): boolean {
    return isRecordReleasable({
      grants,
      caller,
      encounter: encounterRef,
      now: at,
      record,
      ...extra,
    });
  }

  describe('fn:granteeMatches', () => {
    it.each([
      [
        'the same issuer and subject',
        { issuer: ISSUER, subject: 'cardiologist-1' },
        true,
      ],
      ['another subject', { issuer: ISSUER, subject: 'someone-else' }, false],
      [
        'another issuer',
        { issuer: 'https://other.example.invalid', subject: 'cardiologist-1' },
        false,
      ],
      [
        'the organization and a held role',
        {
          issuer: ISSUER,
          organizationId: 'org-1',
          roles: ['nurse', 'cardiologist'],
        },
        true,
      ],
      [
        'the organization but no held role',
        { issuer: ISSUER, organizationId: 'org-1', roles: ['nurse'] },
        false,
      ],
      [
        'a held role in another organization',
        { issuer: ISSUER, organizationId: 'org-2', roles: ['cardiologist'] },
        false,
      ],
      [
        'subject right but organization wrong (all present parts must match)',
        {
          issuer: ISSUER,
          subject: 'cardiologist-1',
          organizationId: 'org-2',
          roles: ['cardiologist'],
        },
        false,
      ],
      [
        'organization right but subject wrong',
        {
          issuer: ISSUER,
          subject: 'someone-else',
          organizationId: 'org-1',
          roles: ['cardiologist'],
        },
        false,
      ],
      [
        'every present part',
        {
          issuer: ISSUER,
          subject: 'cardiologist-1',
          organizationId: 'org-1',
          roles: ['cardiologist'],
        },
        true,
      ],
    ])('for %s', (_name, grantee, expected) => {
      expect(granteeMatches(grantee, caller)).toBe(expected);
    });

    it('never matches an organization grantee when the caller has no registry organization', () => {
      expect(
        granteeMatches(
          { issuer: ISSUER, organizationId: 'org-1', roles: ['cardiologist'] },
          {
            issuer: ISSUER,
            subject: 'cardiologist-1',
            roles: ['cardiologist'],
          },
        ),
      ).toBe(false);
    });
  });

  describe('fn:isGrantInForce', () => {
    it.each([
      ['inside the window', '2026-12-01T00:00:00Z', {}, true],
      ['at validFrom', NOW, {}, true],
      ['before validFrom', '2026-11-25T09:59:59Z', {}, false],
      ['exactly at expiresAt', LATER, {}, false],
      ['after expiry', '2027-01-01T00:00:00Z', {}, false],
      ['when revoked', '2026-12-01T00:00:00Z', { revokedAt: NOW }, false],
    ])('is decided %s', (...[, when, overrides, expected]) => {
      expect(
        isGrantInForce(
          grantSchema.parse(with_(grant, overrides)),
          new Date(when),
        ),
      ).toBe(expected);
    });
  });

  describe('fn:grantCoversRecord', () => {
    it.each([
      ['a listed category', allow, cardiac, true],
      ['an unlisted category', allow, dental, false],
      [
        'a restricted record above maxSensitivity',
        allow,
        cardiacRestricted,
        false,
      ],
      ['baseline through allowBaseline', allow, baseline, true],
      ['a deny grant over its category', deny, cardiac, true],
      [
        'a deny grant over a restricted record in its category',
        deny,
        cardiacRestricted,
        true,
      ],
      ['a deny grant over another category', deny, dental, false],
    ])('covers %s: %s', (...[, candidate, record, expected]) => {
      expect(grantCoversRecord(candidate, record)).toBe(expected);
    });

    it('releases baseline only through allowBaseline, never through categories', () => {
      const noBaseline = grantSchema.parse(
        with_(grant, { allowBaseline: false }),
      );

      expect(grantCoversRecord(noBaseline, baseline)).toBe(false);
      expect(grantCoversRecord(noBaseline, cardiac)).toBe(true);
    });

    it('applies allowedRecordIds to every record, baseline included', () => {
      const listed = grantSchema.parse(
        with_(grant, { allowedRecordIds: ['rec-c'] }),
      );

      expect(grantCoversRecord(listed, cardiac)).toBe(true);
      expect(grantCoversRecord(listed, baseline)).toBe(false);
      expect(
        grantCoversRecord(
          grantSchema.parse(with_(grant, { allowedRecordIds: ['rec-b'] })),
          baseline,
        ),
      ).toBe(true);
      expect(
        grantCoversRecord(
          grantSchema.parse(
            with_(grant, { allowedRecordIds: ['rec-b'], allowBaseline: false }),
          ),
          baseline,
        ),
      ).toBe(false);
    });

    it('lets a deny cover every sensitivity in its category, whatever its maxSensitivity', () => {
      const routineDeny = grantSchema.parse(
        with_(grant, {
          effect: 'deny',
          categories: ['cardiac'],
          allowBaseline: false,
        }),
      );

      expect(grantCoversRecord(routineDeny, cardiac)).toBe(true);
      expect(grantCoversRecord(routineDeny, cardiacRestricted)).toBe(true);
    });

    it('never lets a deny grant cover baseline', () => {
      expect(grantCoversRecord(deny, baseline)).toBe(false);
    });
  });

  describe('fn:isRecordReleasable', () => {
    it('releases a covered record to the matching caller', () => {
      expect(releasable([allow], cardiac)).toBe(true);
      expect(releasable([allow], baseline)).toBe(true);
    });

    it('releases nothing without a grant or outside coverage', () => {
      expect(releasable([], cardiac)).toBe(false);
      expect(releasable([allow], dental)).toBe(false);
      expect(releasable([allow], cardiacRestricted)).toBe(false);
    });

    it('lets a routine deny block a restricted record a restricted allow covers', () => {
      const restrictedAllow = grantSchema.parse(
        with_(grant, { maxSensitivity: 'restricted' }),
      );
      const routineDeny = grantSchema.parse(
        with_(grant, {
          id: 'grant-deny-routine',
          effect: 'deny',
          categories: ['cardiac'],
          allowBaseline: false,
          maxSensitivity: 'routine',
        }),
      );

      expect(releasable([restrictedAllow, routineDeny], cardiac)).toBe(false);
      expect(
        releasable([restrictedAllow, routineDeny], cardiacRestricted),
      ).toBe(false);
    });

    it('lets a deny grant override an allow grant', () => {
      expect(releasable([allow, deny], cardiac)).toBe(false);
      expect(releasable([deny, allow], cardiac)).toBe(false);
      expect(releasable([allow, deny], baseline)).toBe(true);
    });

    it('ignores a revoked or expired deny grant but also a revoked or expired allow grant', () => {
      const revokedDeny = grantSchema.parse({ ...deny, revokedAt: NOW });
      const revokedAllow = grantSchema.parse({ ...allow, revokedAt: NOW });

      expect(releasable([allow, revokedDeny], cardiac)).toBe(true);
      expect(releasable([revokedAllow], cardiac)).toBe(false);
      expect(
        releasable([allow], cardiac, { now: new Date('2027-01-01T00:00:00Z') }),
      ).toBe(false);
    });

    it('ignores a grant for another encounter, another purpose or another caller', () => {
      expect(
        releasable([allow], cardiac, {
          encounter: { id: 'enc-2', purpose: 'direct-treatment' },
        }),
      ).toBe(false);
      expect(
        releasable([allow], cardiac, {
          caller: { ...caller, subject: 'someone-else' },
        }),
      ).toBe(false);
    });

    it('treats requestedCategories as narrowing only, with baseline included only when listed', () => {
      expect(
        releasable([allow], cardiac, { requestedCategories: ['cardiac'] }),
      ).toBe(true);
      expect(
        releasable([allow], baseline, { requestedCategories: ['cardiac'] }),
      ).toBe(false);
      expect(
        releasable([allow], baseline, {
          requestedCategories: ['baseline', 'cardiac'],
        }),
      ).toBe(true);
      expect(
        releasable([allow], cardiac, { requestedCategories: ['dental'] }),
      ).toBe(false);
      // asking for a category no grant covers widens nothing
      expect(
        releasable([allow], dental, { requestedCategories: ['dental'] }),
      ).toBe(false);
      // omitted: no narrowing
      expect(
        releasable([allow], baseline, { requestedCategories: undefined }),
      ).toBe(true);
    });

    it('lets an organization grant serve any registry clinician with a held role', () => {
      const orgGrant = grantSchema.parse(
        with_(grant, {
          grantee: {
            issuer: ISSUER,
            organizationId: 'org-1',
            roles: ['cardiologist'],
          },
        }),
      );

      expect(
        releasable([orgGrant], cardiac, {
          caller: { ...caller, subject: 'colleague' },
        }),
      ).toBe(true);
      expect(
        releasable([orgGrant], cardiac, {
          caller: { ...caller, subject: 'colleague', roles: ['nurse'] },
        }),
      ).toBe(false);
    });
  });

  describe('fn:encounterAdmitsCaller', () => {
    const base = {
      clinician: { issuer: ISSUER, subject: 'cardiologist-1' },
      organizationId: undefined,
      startsAt: NOW,
      endsAt: LATER,
      status: 'active',
    } as const;

    it.each([
      [
        'an active encounter naming the caller',
        base,
        caller,
        '2026-12-01T00:00:00Z',
        true,
      ],
      [
        'a planned encounter',
        { ...base, status: 'planned' as const },
        caller,
        '2026-12-01T00:00:00Z',
        false,
      ],
      [
        'a closed encounter',
        { ...base, status: 'closed' as const },
        caller,
        '2026-12-01T00:00:00Z',
        false,
      ],
      [
        'a cancelled encounter',
        { ...base, status: 'cancelled' as const },
        caller,
        '2026-12-01T00:00:00Z',
        false,
      ],
      ['exactly at startsAt', base, caller, NOW, true],
      ['before startsAt', base, caller, '2026-11-25T09:59:59Z', false],
      ['exactly at endsAt', base, caller, LATER, false],
      [
        'another clinician',
        base,
        { ...caller, subject: 'someone-else' },
        '2026-12-01T00:00:00Z',
        false,
      ],
      [
        'the same subject from another issuer',
        base,
        { ...caller, issuer: 'https://other.example.invalid' },
        '2026-12-01T00:00:00Z',
        false,
      ],
      [
        'an organization encounter and a caller in that organization',
        { ...base, clinician: undefined, organizationId: 'org-1' },
        { ...caller, subject: 'colleague' },
        '2026-12-01T00:00:00Z',
        true,
      ],
      [
        'an organization encounter and a caller in another organization',
        { ...base, clinician: undefined, organizationId: 'org-1' },
        { ...caller, organizationId: 'org-2' },
        '2026-12-01T00:00:00Z',
        false,
      ],
      [
        'an organization encounter and a caller with no organization',
        { ...base, clinician: undefined, organizationId: 'org-1' },
        { issuer: ISSUER, subject: 'x', roles: [] },
        '2026-12-01T00:00:00Z',
        false,
      ],
    ])('is decided for %s', (...[, encounterRow, who, when, expected]) => {
      expect(encounterAdmitsCaller(encounterRow, who, new Date(when))).toBe(
        expected,
      );
    });
  });
});

describe('schema:RecordConflict', () => {
  const incoming = {
    ...envelope,
    source: { ...envelope.source, version: '2', sha256: 'b'.repeat(64) },
  };
  const open = {
    id: 'conf-1',
    recordId: 'rec-obs-001',
    boxFileId: '9100000011',
    incomingVersion: '2',
    incomingSha256: 'b'.repeat(64),
    incoming,
    detectedAt: NOW,
    status: 'open',
  };
  const resolvedBy = { issuer: ISSUER, subject: 'owner-1' };

  it('accepts an open, a kept and an accepted conflict', () => {
    expect(recordConflictSchema.safeParse(open).success).toBe(true);
    expect(
      recordConflictSchema.safeParse(
        with_(open, { status: 'kept-original', resolvedBy, resolvedAt: LATER }),
      ).success,
    ).toBe(true);
    expect(
      recordConflictSchema.safeParse(
        with_(open, {
          status: 'accepted-incoming',
          resolvedBy,
          resolvedAt: LATER,
          acceptedRecordId: 'rec-obs-001-v2',
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['an open conflict that names a resolver', { resolvedBy }],
    ['an open conflict with a resolution time', { resolvedAt: LATER }],
    [
      'a resolved conflict with no resolver',
      { status: 'kept-original', resolvedAt: LATER },
    ],
    [
      'a resolved conflict with no time',
      { status: 'kept-original', resolvedBy },
    ],
    [
      'an accepted conflict with no new record id',
      { status: 'accepted-incoming', resolvedBy, resolvedAt: LATER },
    ],
    [
      'a kept conflict that names a new record id',
      {
        status: 'kept-original',
        resolvedBy,
        resolvedAt: LATER,
        acceptedRecordId: 'rec-2',
      },
    ],
    [
      'an accepted conflict that reuses the existing record id',
      {
        status: 'accepted-incoming',
        resolvedBy,
        resolvedAt: LATER,
        acceptedRecordId: 'rec-obs-001',
      },
    ],
    ['an unknown status', { status: 'merged' }],
    [
      'a file id that disagrees with the incoming source',
      { boxFileId: '9100000099' },
    ],
    [
      'an incoming record that is not a valid envelope',
      { incoming: { id: 'x' } },
    ],
    ['an unknown field', { overwrite: true }],
  ])('rejects %s', (...[, overrides]) => {
    expect(recordConflictSchema.safeParse(with_(open, overrides)).success).toBe(
      false,
    );
  });
});
