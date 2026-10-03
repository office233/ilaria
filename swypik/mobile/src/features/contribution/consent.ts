/** Data donation and compute permission are distinct revocable intentions.
 * This milestone has no released training executor and never grants a job.
 */
export type ContributionConsent = { userId: string | null; data: boolean; compute: boolean; epoch: number };
export function initialConsent(userId: string | null = null): ContributionConsent {
  return { userId, data: false, compute: false, epoch: 0 };
}
export function changeConsent(state: ContributionConsent, kind: 'data' | 'compute', enabled: boolean): ContributionConsent {
  if (enabled && !state.userId) throw new Error('authenticated_consent_required');
  return { ...state, [kind]: enabled, epoch: state.epoch + 1 };
}
export function revokeConsent(state: ContributionConsent): ContributionConsent {
  return { userId: state.userId, data: false, compute: false, epoch: state.epoch + 1 };
}
