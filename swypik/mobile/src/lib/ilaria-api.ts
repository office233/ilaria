import type { AuthController, InferenceLease } from './auth-core.ts';
import { decodeResponse, makeRequest, readBounded, type CorticalRequest, type CorticalResponse } from './ilaria-wire.ts';

export type IlariaState = {
  status: 'idle' | 'unavailable' | 'running' | 'stopping' | 'stopped' | 'uncertain' | 'succeeded' | 'error' | 'parked';
  response: CorticalResponse | null;
  message: string;
};
type OwnedRun = {
  request: CorticalRequest; lease: InferenceLease; abort: AbortController;
  timer: ReturnType<typeof setTimeout>; generation: number;
};
/** No React/native dependencies: foreground/session/cancel behavior can be tested deterministically. */
export class IlariaClient {
  private run: OwnedRun | null = null;
  private generation = 0;
  private foreground = false;
  private remoteConsent = false;
  private stopped = false;
  private cancellation: Promise<void> | null = null;
  private unsubscribe: () => void;
  private auth: AuthController;
  private publish: (state: IlariaState) => void;
  private fetcher: typeof fetch;
  private state: IlariaState = { status: 'idle', response: null, message: '' };
  constructor(auth: AuthController, publish: (state: IlariaState) => void, fetcher: typeof fetch = fetch) {
    this.auth = auth; this.publish = publish; this.fetcher = fetcher;
    this.unsubscribe = auth.subscribe(state => {
      if (this.run && (state.status !== 'authenticated' || state.user?.userId !== this.run.lease.userId)) void this.cancel('session');
      if (state.status !== 'authenticated') this.emit({ status: 'unavailable', response: null, message: 'Autentificarea verificată este necesară.' });
    });
  }
  getState() { return this.state; }
  private emit(state: IlariaState) { this.state = state; if (!this.stopped) this.publish(state); }
  setForeground(active: boolean) {
    this.foreground = active;
    if (!active) {
      if (this.run) void this.cancel('background');
      else this.emit({ status: 'parked', response: null, message: 'Ilaria este în pauză când aplicația nu este în prim-plan.' });
    }
  }
  setRemoteConsent(value: boolean) {
    this.remoteConsent = value;
    if (!value) {
      if (this.run) void this.cancel('consent');
      else this.emit({ status: 'idle', response: null, message: 'Trimiterea întrebării către gazda Ilaria este oprită.' });
    }
  }
  async start(goal: string): Promise<void> {
    if (this.stopped || this.run || this.cancellation) return;
    if (!this.foreground || !this.remoteConsent || this.auth.getState().status !== 'authenticated') {
      this.emit({ status: 'unavailable', response: null, message: 'Ai nevoie de autentificare, prim-plan și acord pentru inferență la distanță.' });
      return;
    }
    let lease: InferenceLease;
    try { lease = this.auth.authorizeInference(this.fetcher); }
    catch {
      this.emit({ status: 'unavailable', response: null, message: 'Gateway-ul autenticat nu este configurat pentru această sesiune.' }); return;
    }
    let request: CorticalRequest;
    try { request = makeRequest(goal, lease.userId, Date.now(), this.auth.getSessionExpiresAt() ?? 0); }
    catch { lease.close(); this.emit({ status: 'error', response: null, message: 'Întrebarea sau termenul sesiunii nu este valid.' }); return; }
    const owned: OwnedRun = {
      request, lease, abort: new AbortController(), generation: ++this.generation,
      timer: setTimeout(() => { void this.cancel('deadline'); }, Math.max(1, request.deadline_unix_ms - Date.now())),
    };
    this.run = owned;
    this.emit({ status: 'running', response: null, message: 'Cerere trimisă către executorul Ilaria.' });
    try {
      const response = await lease.infer(request.task_id, JSON.stringify(request), owned.abort.signal);
      if (!response.ok) throw new Error('gateway_refused');
      const text = await readBounded(response, owned.abort.signal);
      const answer = decodeResponse(text, request.task_id);
      if (answer.compute_cost > request.compute_budget) throw new Error('budget_correlation');
      if (this.run !== owned || this.generation !== owned.generation || !lease.isCurrent() ||
          !this.foreground || !this.remoteConsent || owned.abort.signal.aborted) return;
      // setTimeout may not have fired yet when a response continuation resumes.
      // The request deadline is authoritative; use the correlated server cancel path.
      if (Date.now() >= request.deadline_unix_ms) { void this.cancel('deadline'); return; }
      this.emit({ status: 'succeeded', response: answer,
        message: answer.runtime_metrics.canary === 'true' ? 'Model IMC canary de test; calitatea conversațională nu este certificată.' : 'Răspuns Ilaria verificat la granița protocolului; calitatea nu este certificată.' });
    } catch {
      if (this.run === owned && this.generation === owned.generation && !owned.abort.signal.aborted) {
        this.emit({ status: 'error', response: null, message: 'Gateway-ul nu a confirmat un răspuns Ilaria valid. Nu s-au folosit datele pentru antrenare.' });
      }
    } finally {
      if (this.run === owned && this.generation === owned.generation) {
        clearTimeout(owned.timer); lease.close(); this.run = null;
      }
    }
  }
  cancel(_reason: 'user' | 'background' | 'session' | 'consent' | 'deadline' | 'unmount' = 'user'): Promise<void> {
    if (this.cancellation) return this.cancellation;
    const owned = this.run;
    if (!owned) { this.emit({ status: this.foreground ? 'stopped' : 'parked', response: null, message: 'Nicio execuție locală în curs.' }); return Promise.resolve(); }
    ++this.generation;
    clearTimeout(owned.timer); owned.abort.abort();
    this.emit({ status: 'stopping', response: null, message: 'Oprire solicitată; așteptăm confirmarea executorului.' });
    const operation = async () => {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 2000);
      try {
        const response = await owned.lease.cancel(owned.request.task_id, abort.signal);
        if (!response.ok) throw new Error('cancel_refused');
        const reply = decodeResponse(await readBounded(response, abort.signal), owned.request.task_id, true);
        const status = reply.runtime_metrics.execution_status;
        if (!['stopped', 'succeeded', 'failed'].includes(status)) throw new Error('cancel_uncertain');
        this.emit({ status: this.foreground ? 'stopped' : 'parked', response: null, message: status === 'stopped'
          ? 'Executorul a confirmat oprirea.' : 'Executorul era deja încheiat înaintea anulării.' });
      } catch {
        this.emit({ status: 'uncertain', response: null, message: 'Oprirea pe server nu a fost confirmată. Lease-ul are termen limitat; nu presupune că execuția s-a oprit deja.' });
      } finally {
        clearTimeout(timer); owned.lease.close();
        if (this.run === owned) this.run = null;
      }
    };
    this.cancellation = operation().finally(() => { this.cancellation = null; });
    return this.cancellation;
  }
  close() {
    this.stopped = true; this.unsubscribe(); void this.cancel('unmount');
  }
}
