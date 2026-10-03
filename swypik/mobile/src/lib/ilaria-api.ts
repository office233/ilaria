import { AuthError, type AuthController, type InferenceLease } from './auth-core.ts';
import { decodeResponse, makeRequest, readBounded, type CorticalRequest, type CorticalResponse } from './ilaria-wire.ts';

export type IlariaState = {
  status: 'idle' | 'unavailable' | 'running' | 'stopping' | 'stopped' | 'uncertain' | 'succeeded' | 'error' | 'offline' | 'parked';
  response: CorticalResponse | null;
  message: string;
};
type OwnedRun = {
  request: CorticalRequest; lease: InferenceLease; abort: AbortController;
  timer: ReturnType<typeof setTimeout>; generation: number;
  dispatched: boolean; failure: 'error' | 'offline' | null;
};
// Admission survives screen remounts, but contains no prompt or credential.
// Only a correlated terminal acknowledgement releases an issued task.
const pendingExecutions = new WeakMap<AuthController, string>();
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
    if (pendingExecutions.has(auth)) this.uncertain();
    this.unsubscribe = auth.subscribe(state => {
      if (state.status !== 'authenticated' || (this.run && state.user?.userId !== this.run.lease.userId)) {
        this.remoteConsent = false;
        if (this.run && this.state.status !== 'uncertain') void this.cancel('session');
        else if (pendingExecutions.has(auth)) this.uncertain();
        else this.emit({ status: 'unavailable', response: null, message: 'Autentificarea verificată este necesară.' });
      }
    });
  }
  getState() { return this.state; }
  private emit(state: IlariaState) { this.state = state; if (!this.stopped) this.publish(state); }
  private uncertain() {
    this.emit({ status: 'uncertain', response: null, message: 'Oprirea pe server nu a fost confirmată. Nu trimitem alte cereri până la reconcilierea execuției; termenul lease-ului nu este o dovadă de oprire.' });
  }
  private release(owned: OwnedRun) {
    clearTimeout(owned.timer); owned.lease.close();
    if (this.run === owned) this.run = null;
    if (pendingExecutions.get(this.auth) === owned.request.task_id) pendingExecutions.delete(this.auth);
  }
  setForeground(active: boolean) {
    this.foreground = active;
    if (!active) {
      if (this.run && this.state.status !== 'uncertain') void this.cancel('background');
      else if (pendingExecutions.has(this.auth)) this.uncertain();
      else this.emit({ status: 'parked', response: null, message: 'Ilaria este în pauză când aplicația nu este în prim-plan.' });
    }
  }
  setRemoteConsent(value: boolean) {
    this.remoteConsent = value;
    if (!value) {
      if (this.run && this.state.status !== 'uncertain') void this.cancel('consent');
      else if (pendingExecutions.has(this.auth)) this.uncertain();
      else this.emit({ status: 'idle', response: null, message: 'Trimiterea întrebării către gazda Ilaria este oprită.' });
    }
  }
  async start(goal: string): Promise<void> {
    if (this.stopped) return;
    if (this.run || this.cancellation || pendingExecutions.has(this.auth)) {
      if (!this.run && !this.cancellation) this.uncertain();
      return;
    }
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
      dispatched: false, failure: null,
    };
    this.run = owned;
    pendingExecutions.set(this.auth, request.task_id);
    this.emit({ status: 'running', response: null, message: 'Cerere trimisă către executorul Ilaria.' });
    try {
      if (this.run !== owned || owned.abort.signal.aborted) return;
      owned.dispatched = true;
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
      this.release(owned);
      this.emit({ status: 'succeeded', response: answer,
        message: answer.runtime_metrics.canary === 'true' ? 'Model IMC canary de test; calitatea conversațională nu este certificată.' : 'Răspuns Ilaria verificat la granița protocolului; calitatea nu este certificată.' });
    } catch (error) {
      if (this.run === owned && this.generation === owned.generation && !owned.abort.signal.aborted) {
        owned.failure = error instanceof AuthError && ['network', 'timeout'].includes(error.code) ? 'offline' : 'error';
        await this.cancel('failure');
      }
    }
  }
  cancel(_reason: 'user' | 'background' | 'session' | 'consent' | 'deadline' | 'unmount' | 'failure' = 'user'): Promise<void> {
    if (this.cancellation) return this.cancellation;
    const owned = this.run;
    if (!owned) {
      if (pendingExecutions.has(this.auth)) this.uncertain();
      else this.emit({ status: this.foreground ? 'stopped' : 'parked', response: null, message: 'Nicio cerere Ilaria în curs în acest client.' });
      return Promise.resolve();
    }
    ++this.generation;
    clearTimeout(owned.timer); owned.abort.abort();
    if (!owned.dispatched) {
      this.release(owned);
      this.emit({ status: 'stopped', response: null, message: 'Cererea a fost oprită înainte de trimitere.' });
      return Promise.resolve();
    }
    this.emit({ status: 'stopping', response: null, message: 'Oprire solicitată; așteptăm confirmarea executorului.' });
    const operation = async () => {
      const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 2000);
      try {
        const response = await owned.lease.cancel(owned.request.task_id, abort.signal);
        if (!response.ok) throw new Error('cancel_refused');
        const reply = decodeResponse(await readBounded(response, abort.signal), owned.request.task_id, true);
        const status = reply.runtime_metrics.execution_status;
        if (!['stopped', 'succeeded', 'failed'].includes(status)) throw new Error('cancel_uncertain');
        this.release(owned);
        this.emit({ status: owned.failure ?? (this.foreground ? 'stopped' : 'parked'), response: null,
          message: owned.failure
            ? 'Gateway-ul nu a confirmat un răspuns Ilaria valid. Executorul a confirmat încheierea; nu există fallback la alt model și antrenarea nu este autorizată.'
            : status === 'stopped' ? 'Executorul a confirmat oprirea.' : 'Executorul era deja încheiat înaintea anulării.' });
      } catch {
        this.uncertain();
      } finally {
        clearTimeout(timer);
        if (this.stopped) {
          owned.lease.close();
          if (this.run === owned) this.run = null;
        }
      }
    };
    this.cancellation = operation().finally(() => { this.cancellation = null; });
    return this.cancellation;
  }
  close() {
    this.stopped = true; this.unsubscribe(); void this.cancel('unmount');
  }
}
