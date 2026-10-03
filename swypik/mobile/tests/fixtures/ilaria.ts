import { AuthController, type AuthApi } from '../../src/lib/auth-core.ts';
import type { CorticalResponse } from '../../src/lib/ilaria-wire.ts';

export async function fixtureAuth() {
  const api: AuthApi = { inferenceOrigin: 'https://auth.example.test',
    async login() { return { token: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00Z' }; },
    async profile() { return { userId: 'fixture-user', role: 'shopper', email: null, displayName: null }; },
    async refresh() { throw new Error('unused'); }, async revoke() {} };
  const controller = new AuthController(api, { async read() { return null; }, async write() {} }, true);
  await controller.signIn('fixture@example.test', 'synthetic-password');
  return controller;
}

export function controlResponse(task: string, status = 'stopped'): CorticalResponse {
  return { protocol_version: 1, task_id: task, expert_id: 'GatewayControl', expert_version: 'gateway-v1',
    hypothesis: '', claims: [], evidence_refs: [], contradictions: [], uncertainty_ppm: 1000000, confidence_ppm: 0,
    next_expert_suggestions: [], verification_requirements: [], proposed_swyp_plan: '', latent_summary: '',
    compute_cost: 0, runtime_metrics: { execution_status: status, training: 'unavailable', energy_joules: 'unmeasured' } };
}

export function inferenceResponse(task: string): CorticalResponse {
  const hash = 'a'.repeat(64);
  return { protocol_version: 1, task_id: task, expert_id: 'IMC', expert_version: 'imc-v1:' + hash,
    hypothesis: 'fixture answer', claims: [], evidence_refs: ['model:sha256:' + hash], contradictions: [],
    uncertainty_ppm: 0, confidence_ppm: 1000000, next_expert_suggestions: [], verification_requirements: [],
    proposed_swyp_plan: '', latent_summary: '', compute_cost: 1,
    runtime_metrics: { execution_status: 'succeeded', training: 'unavailable', canary: 'true',
      model_hash: hash, tokenizer_hash: hash, config_hash: hash, canonical_source_hash: hash,
      forward_passes: '1', output_tokens: '1' } };
}
