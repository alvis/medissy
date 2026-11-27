/**
 * the narrow port the A2A task engine uses to reach the disclosure pipeline
 * (src/disclosure, DIS02), through its public exports only; the engine never
 * imports the pipeline directly: this adapter is the one place that changes
 * if the pipeline's API does
 *
 * every call is made for the clinician bound to the task by the institution
 * device sign-in (D10, ADR-9), never for whoever polls or anyone the message names;
 * any throw fails closed as a `temporarily-unavailable` denial
 */
import { disclose, redisclose } from '../disclosure';

import type {
  ClinicalRequest,
  DisclosureDenial,
  DisclosureResult,
  PersonRef,
  Principal,
} from '../contracts';
import type { DisclosureDeps } from '../disclosure';

/** what the engine gets back: a grounded release or a safe denial */
export type PortOutcome =
  | { kind: 'released'; result: DisclosureResult }
  | { kind: 'denied'; denial: DisclosureDenial };

/** the disclosure operations the task engine needs */
export interface DisclosurePort {
  /**
   * decides and releases (or denies) a new request for the bound principal;
   * idempotent per (caller, requestId): a repeat re-authorises and returns
   * the same receipt
   */
  disclose(input: {
    principal: Principal;
    patientId: string;
    request: ClinicalRequest;
  }): Promise<PortOutcome>;
  /**
   * re-checks a stored release for the bound person; writes no new receipt;
   * with no receipt for the request it denies (`not-permitted`)
   */
  redisclose(input: {
    caller: PersonRef;
    patientId: string;
    requestId: string;
  }): Promise<PortOutcome>;
}

/**
 * binds the port to the DIS02 pipeline
 * @param deps the pipeline's vault, clock, selector client and logger
 * @returns a port that runs the disclosure pipeline
 */
export function createPipelinePort(deps: DisclosureDeps): DisclosurePort {
  const narrow = (
    outcome: Awaited<ReturnType<typeof disclose>>,
  ): PortOutcome =>
    outcome.kind === 'released'
      ? { kind: 'released', result: outcome.result }
      : { kind: 'denied', denial: outcome.denial };

  return {
    disclose: async (input) =>
      failClosed(input.request.requestId, async () =>
        narrow(await disclose(deps, input)),
      ),
    redisclose: async (input) =>
      failClosed(input.requestId, async () => narrow(redisclose(deps, input))),
  };
}

/** the fixed denial for a pipeline call that threw */
export const UNAVAILABLE_MESSAGE =
  'Evidence is temporarily unavailable. Nothing was released.';

/**
 * runs a pipeline call so that a throw releases nothing: it becomes a
 * `temporarily-unavailable` denial carrying no error text
 * @param requestId the request the call was for
 * @param body the call
 * @returns the outcome, or the fixed denial
 */
export async function failClosed(
  requestId: string,
  body: () => Promise<PortOutcome>,
): Promise<PortOutcome> {
  try {
    return await body();
  } catch {
    return {
      kind: 'denied',
      denial: {
        requestId,
        kind: 'denied',
        code: 'temporarily-unavailable',
        message: UNAVAILABLE_MESSAGE,
      },
    };
  }
}
