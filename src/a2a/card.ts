/**
 * Medissy's generic A2A 1.0 Agent Card; it names no patient, record,
 * encounter, clinician or hospital: anyone may fetch it; identity is bound
 * inside the task by a device sign-in (D8) at the issuer the flow picks (a
 * clinician at the trusted institution, the owner at the patient's issuer;
 * ADR-9), so the JSON-RPC endpoint accepts no bearer token, the card states
 * no security requirement and advertises no issuer: naming the trusted
 * institution would reveal where the patient is treated
 */
import { AgentCard } from '@a2a-js/sdk';

import { DISCLOSURE_MEDIA_TYPE, SUBMISSION_MEDIA_TYPE } from '../contracts';
import { SHARE_MEDIA_TYPE } from '../widgets';

import {
  SKILL_CLINICAL,
  SKILL_REDEEM,
  SKILL_SHARE,
  SKILL_SUBMIT,
} from './intent';
import { SIGNIN_MEDIA_TYPE } from './transitions';

/** path of the JSON-RPC endpoint */
export const A2A_PATH = '/a2a/v1';
/** path of the Agent Card */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
/** the A2A protocol version served */
export const PROTOCOL_VERSION = '1.0';

/** what the card is built from */
export interface CardOptions {
  /** Medissy's public origin, e.g. `https://medissy.sprites.app` */
  publicUrl: string;
  /** true once the owner-scoped sign-in for share codes is configured */
  shareCodeAvailable?: boolean;
  /** true once a secure store for handed-back records is configured */
  recordSubmissionAvailable?: boolean;
}

/** the card in ProtoJSON form */
export type AgentCardJson = Record<string, unknown>;

/**
 * builds the record-submission skill (ADR-10): generic, no patient data
 * @param available true when a secure store is configured here
 * @returns the skill entry
 */
function submitSkill(available: boolean): Record<string, unknown> {
  return {
    id: SKILL_SUBMIT,
    name: 'Submit record',
    description: available
      ? 'Hand a new record back to the patient: send a data part {"skill":"submit-record","record":<FHIR R4 Observation, DiagnosticReport, DocumentReference, Condition, MedicationStatement or AllergyIntolerance>} or {"skill":"submit-record","document":{"title","text","authoredAt?"}}, optionally with "category". At most 64 KiB; no contained resources, no attachment URLs, no other patient. The task asks the clinician to sign in; with an active grant the record is filed to the patient\'s secure store and returned as a receipt. The patient can remove it.'
      : 'Hand a new record back to the patient under an active grant. Not available in this deployment.',
    tags: ['records', 'fhir', 'hand-back'],
    examples: [
      '{"skill":"submit-record","document":{"title":"Cardiology follow-up note","text":"SYNTHETIC: stable on current medication."}}',
    ],
    inputModes: ['application/json'],
    outputModes: [
      'text/plain',
      SIGNIN_MEDIA_TYPE,
      SUBMISSION_MEDIA_TYPE,
      DISCLOSURE_MEDIA_TYPE,
    ],
  };
}

/**
 * lists the skills the card advertises
 * @param available which optional skills are configured
 * @param available.shareCode true when the owner can mint invitations here
 * @param available.recordSubmission true when records can be handed back
 * @returns one entry per request the agent accepts
 */
function cardSkills(available: {
  shareCode: boolean;
  recordSubmission: boolean;
}): Array<Record<string, unknown>> {
  const shareCodeAvailable = available.shareCode;

  return [
    {
      id: SKILL_CLINICAL,
      name: 'Clinical evidence request',
      description:
        'Send a data part {"skill":"clinical-evidence-request","encounterId","question"} (optionally requestId, requestedCategories). The task asks the clinician to sign in, then returns a summary, the structured result with a FHIR R4 Bundle, and an escaped HTML card; poll it with GetTask.',
      tags: ['clinical', 'evidence', 'fhir', 'consent'],
      examples: [
        '{"skill":"clinical-evidence-request","encounterId":"enc-cardiology-review","question":"Current cardiac medications and allergies?"}',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: [
        'text/plain',
        DISCLOSURE_MEDIA_TYPE,
        SIGNIN_MEDIA_TYPE,
        'text/html',
      ],
    },
    {
      id: SKILL_REDEEM,
      name: 'Redeem invitation',
      description:
        'Send a data part {"skill":"redeem-invitation","code":"<share link>"}. The task asks the clinician to sign in, then redeems the single-use invitation: it ends pending patient confirmation and shares nothing until the patient confirms.',
      tags: ['sharing', 'connection'],
      examples: [
        '{"skill":"redeem-invitation","code":"https://medissy.example/connect#<token>"}',
      ],
      inputModes: ['application/json'],
      outputModes: ['text/plain', SIGNIN_MEDIA_TYPE],
    },
    {
      id: SKILL_SHARE,
      name: 'Share code',
      description: shareCodeAvailable
        ? 'Patient-owner only: send {"skill":"share-code"}. The task asks the patient to sign in (medissy:owner); only the owner of record gets a single-use invitation, returned once as text with an SVG QR code, the invitation data and an HTML card.'
        : 'Patient-owner only: returns a share invitation with a QR code. Not available in this deployment.',
      tags: ['sharing', 'owner'],
      examples: ['{"skill":"share-code"}'],
      inputModes: ['application/json'],
      outputModes: [
        'text/plain',
        SIGNIN_MEDIA_TYPE,
        SHARE_MEDIA_TYPE,
        'text/html',
      ],
    },
    submitSkill(available.recordSubmission),
  ];
}

/**
 * builds the card JSON
 * @param options origin and feature switches
 * @returns the card, with no patient data
 */
export function agentCardJson(options: CardOptions): AgentCardJson {
  const base = options.publicUrl.replace(/\/$/, '');

  return {
    name: 'Medissy (SYNTHETIC DEMO)',
    description:
      "A patient's own agent. It answers a clinician's question with a selective, consented, source-linked extract, decided for the clinician who signs in. Hackathon prototype; synthetic data only.",
    supportedInterfaces: [
      {
        url: `${base}${A2A_PATH}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: PROTOCOL_VERSION,
      },
    ],
    provider: { organization: 'Medissy hackathon prototype', url: base },
    version: '0.1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: [
      'text/plain',
      DISCLOSURE_MEDIA_TYPE,
      SIGNIN_MEDIA_TYPE,
      'text/html',
    ],
    skills: cardSkills({
      shareCode: options.shareCodeAvailable === true,
      recordSubmission: options.recordSubmissionAvailable === true,
    }),
  };
}

/**
 * returns the card as the SDK type, for the request handler and version checks
 * @param options origin and feature switches
 * @returns the decoded card
 */
export function agentCard(options: CardOptions): AgentCard {
  return AgentCard.fromJSON(agentCardJson(options));
}
