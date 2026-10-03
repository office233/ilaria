import type { ContributionConsent } from './consent.ts';

export const contributionAvailability = {
  data: 'unavailable', compute: 'awaiting-release', phoneExecutor: 'unavailable',
} as const;
export function requireContributionExecutor(_consent: ContributionConsent): never {
  // No stable released network/mobile executor exists in this slice.
  // Consent cannot mint issuer authority or silently send gallery/chat data.
  throw new Error('contribution_executor_unavailable');
}
