/**
 * the sharing ports of the A2A surface
 *
 * - invitation redemption (clinician): a task signs the clinician in through
 *   the device flow, then redeems the invitation for that verified person
 * - share code (patient owner only): a task signs the patient in through the
 *   owner-scoped device flow (`medissy:owner`); only the owner of record
 *   binds it and receives a new single-use invitation
 */
import type { PersonRef } from '../contracts';
import type { ShareInvitation } from '../widgets';

/** issues share invitations for the verified patient owner */
export interface ShareCodePort {
  /** checks whether the verified person is the vault's owner of record */
  isOwner(person: PersonRef): boolean;
  /**
   * @param input the arguments
   * @param input.owner the verified owner
   * @returns the invitation (URL with the token, and expiry), or undefined
   *   when the person is not the owner
   */
  create(input: { owner: PersonRef }): ShareInvitation | undefined;
}

/** redeems an invitation for a verified clinician */
export interface InvitationPort {
  /**
   * @param input the redemption
   * @param input.tokenHash the SHA-256 of the invitation token
   * @param input.requester the verified clinician
   * @returns whether a pending connection was opened
   */
  redeem(input: { tokenHash: string; requester: PersonRef }): { ok: boolean };
}
