/** TypeScript projection of canonical Myriad v1 (not an independent protocol).
 * Numeric fields use the explicitly bounded safe-integer subset; unsafe values fail.
 */
export const MAX_WIRE_BYTES = 65536;
export type CorticalRequest = {
  protocol_version: number; task_id: string; parent_task_id: string; initiator: string;
  language: string; modality: string; goal: string; privacy_class: string; domain_signature: string;
  evidence_refs: string[]; hippocampus_refs: string[]; working_memory_summary: string;
  tool_observations: string[]; constraints: string[]; desired_output_schema: string;
  deadline_unix_ms: number; compute_budget: number; confidence_requirement: number; requested_role: string;
};
export type CorticalResponse = {
  protocol_version: number; task_id: string; expert_id: string; expert_version: string;
  hypothesis: string; claims: string[]; evidence_refs: string[]; contradictions: string[];
  uncertainty_ppm: number; confidence_ppm: number; next_expert_suggestions: string[];
  verification_requirements: string[]; proposed_swyp_plan: string; latent_summary: string;
  compute_cost: number; runtime_metrics: Record<string, string>;
};
export const REQUEST_FIELDS = {
  protocol_version: 'u64', task_id: 'string', parent_task_id: 'string', initiator: 'string',
  language: 'string', modality: 'string', goal: 'string', privacy_class: 'string', domain_signature: 'string',
  evidence_refs: 'string_list', hippocampus_refs: 'string_list', working_memory_summary: 'string',
  tool_observations: 'string_list', constraints: 'string_list', desired_output_schema: 'string',
  deadline_unix_ms: 'i64', compute_budget: 'u64', confidence_requirement: 'u64', requested_role: 'string',
} as const;
export const RESPONSE_FIELDS = {
  protocol_version: 'u64', task_id: 'string', expert_id: 'string', expert_version: 'string',
  hypothesis: 'string', claims: 'string_list', evidence_refs: 'string_list', contradictions: 'string_list',
  uncertainty_ppm: 'u64', confidence_ppm: 'u64', next_expert_suggestions: 'string_list',
  verification_requirements: 'string_list', proposed_swyp_plan: 'string', latent_summary: 'string',
  compute_cost: 'u64', runtime_metrics: 'string_map',
} as const;
export class WireError extends Error { constructor() { super('invalid_cortical_wire'); } }
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new WireError();
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new WireError();
    else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return bytes;
}
/** Parse before JSON.parse can discard duplicate keys or integer precision. */
export function strictJSON(text: string): unknown {
  if (utf8Bytes(text) > MAX_WIRE_BYTES) throw new WireError();
  let pos = 0;
  const space = () => { while (pos < text.length && /[\t\n\r ]/.test(text[pos])) pos++; };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '\\') { pos++; continue; }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, pos));
        if (typeof value !== 'string') throw new WireError();
        utf8Bytes(value); return value;
      }
    }
    throw new WireError();
  };
  const read = (depth: number): unknown => {
    if (depth > 16) throw new WireError();
    space(); const c = text[pos];
    if (c === '"') return string();
    if (c === '{') {
      pos++; space(); const object: Record<string, unknown> = Object.create(null);
      if (text[pos] === '}') { pos++; return object; }
      while (true) {
        space(); if (text[pos] !== '"') throw new WireError();
        const key = string(); if (Object.hasOwn(object, key)) throw new WireError();
        space(); if (text[pos++] !== ':') throw new WireError();
        object[key] = read(depth + 1); space();
        const end = text[pos++]; if (end === '}') return object;
        if (end !== ',') throw new WireError();
      }
    }
    if (c === '[') {
      pos++; space(); const array: unknown[] = [];
      if (text[pos] === ']') { pos++; return array; }
      while (true) {
        if (array.length >= 32) throw new WireError();
        array.push(read(depth + 1)); space();
        const end = text[pos++]; if (end === ']') return array;
        if (end !== ',') throw new WireError();
      }
    }
    for (const [literal, value] of [['null', null], ['true', true], ['false', false]] as const) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return value; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(text.slice(pos));
    if (!match) throw new WireError();
    pos += match[0].length; const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) throw new WireError();
    return value;
  };
  const value = read(0); space(); if (pos !== text.length) throw new WireError(); return value;
}
function record(value: unknown, schema: Record<string, string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WireError();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== Object.keys(schema).length) throw new WireError();
  for (const [key, type] of Object.entries(schema)) {
    if (!Object.hasOwn(object, key)) throw new WireError();
    const v = object[key];
    if (type === 'string' && (typeof v !== 'string' || utf8Bytes(v) > 4096)) throw new WireError();
    if ((type === 'u64' || type === 'i64') && (typeof v !== 'number' || !Number.isSafeInteger(v) || (type === 'u64' && v < 0))) throw new WireError();
    if (type === 'string_list' && (!Array.isArray(v) || v.length > 16 || v.some(x => typeof x !== 'string' || utf8Bytes(x) > 4096))) throw new WireError();
    if (type === 'string_map') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 32 ||
          Object.entries(v).some(([k, x]) => utf8Bytes(k) > 128 || typeof x !== 'string' || utf8Bytes(x) > 4096)) throw new WireError();
    }
  }
  return object;
}
let sequence = 0;
export function makeRequest(goal: string, userId: string, now = Date.now(), expiresAt = now + 25000): CorticalRequest {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(userId) || userId.trim() !== userId || !goal.trim() || utf8Bytes(goal) > 4096 ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new WireError();
  const request: CorticalRequest = {
    protocol_version: 1, task_id: 'mobile.' + now + '.' + (++sequence), parent_task_id: '', initiator: userId,
    language: 'ro', modality: 'text', goal, privacy_class: 'LOCAL_PRIVATE', domain_signature: 'general',
    evidence_refs: [], hippocampus_refs: [], working_memory_summary: '', tool_observations: [],
    constraints: ['no_training', 'no_tools'], desired_output_schema: 'CorticalResponse',
    deadline_unix_ms: Math.min(now + 25000, expiresAt), compute_budget: 4, confidence_requirement: 0, requested_role: 'inference',
  };
  record(request, REQUEST_FIELDS);
  return request;
}
export function decodeResponse(text: string, taskId: string, control = false): CorticalResponse {
  const response = record(strictJSON(text), RESPONSE_FIELDS) as CorticalResponse;
  if (response.protocol_version !== 1 || response.task_id !== taskId || response.confidence_ppm > 1000000 ||
      response.uncertainty_ppm > 1000000 || response.proposed_swyp_plan || response.latent_summary ||
      response.runtime_metrics.training !== 'unavailable') throw new WireError();
  const metrics = response.runtime_metrics;
  if (control) {
    if (response.expert_id !== 'GatewayControl' || response.expert_version !== 'gateway-v1' ||
        !['running', 'stopped', 'succeeded', 'failed', 'uncertain', 'unknown'].includes(metrics.execution_status)) throw new WireError();
  } else {
    if (response.expert_id !== 'IMC' || !response.hypothesis || metrics.execution_status !== 'succeeded' ||
        !['true', 'false'].includes(metrics.canary) || response.compute_cost < 1 || response.compute_cost > 16) throw new WireError();
    for (const key of ['model_hash', 'tokenizer_hash', 'config_hash', 'canonical_source_hash']) {
      if (typeof metrics[key] !== 'string' || !/^[0-9a-f]{64}$/.test(metrics[key])) throw new WireError();
    }
    if (response.expert_version !== 'imc-v1:' + metrics.config_hash ||
        response.evidence_refs.length !== 1 || response.evidence_refs[0] !== 'model:sha256:' + metrics.model_hash ||
        metrics.forward_passes !== String(response.compute_cost) || metrics.output_tokens !== String(response.compute_cost)) throw new WireError();
  }
  return response;
}
export async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || response.redirected) throw new WireError();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_WIRE_BYTES)) throw new WireError();
  const reader = response.body?.getReader?.();
  const aborted = () => { void reader?.cancel().catch(() => undefined); };
  signal.addEventListener('abort', aborted, { once: true });
  const work = async () => {
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, text = '';
      while (true) {
        if (signal.aborted) throw new WireError();
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > MAX_WIRE_BYTES) throw new WireError();
        text += decoder.decode(chunk.value, { stream: true });
      }
      if (length !== null && bytes !== Number(length)) throw new WireError();
      return text + decoder.decode();
    }
    // Native fetch may buffer internally. Require the bounded gateway length,
    // enforce decoded bytes too; physical-device native capture remains unverified.
    if (length === null) throw new WireError();
    const text = await response.text();
    if (utf8Bytes(text) !== Number(length) || utf8Bytes(text) > MAX_WIRE_BYTES || text.includes('\ufffd')) throw new WireError();
    return text;
  };
  let onAbort: (() => void) | undefined;
  try {
    if (signal.aborted) throw new WireError();
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new WireError()); signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener('abort', aborted);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (reader) { void reader.cancel().catch(() => undefined); }
  }
}
