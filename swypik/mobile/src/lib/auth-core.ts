/** Native authentication contract. No React, device APIs, credentials, or production defaults. */
export type AuthConfig = { enabled: false; reason: string } | { enabled: true; origin: string };
export type SessionRecord = { token: string; expiresAt: string };
export type Profile = {
  userId: string; role: 'shopper' | 'creator' | 'seller' | 'admin';
  email: string | null; displayName: string | null;
};
export type AuthState = {
  status: 'signed-out' | 'loading' | 'authenticated' | 'offline' | 'error';
  user: Profile | null;
  message?: string;
};
export interface SessionStorage {
  read(): Promise<string | null>;
  write(value: string | null): Promise<void>;
}
export interface InferenceLease {
  readonly userId: string;
  isCurrent(): boolean;
  infer(taskId: string, body: string, signal: AbortSignal): Promise<Response>;
  cancel(taskId: string, signal?: AbortSignal): Promise<Response>;
  close(): void;
}
export interface AuthApi {
  readonly inferenceOrigin?: string;
  login(email: string, password: string): Promise<SessionRecord>;
  profile(token: string): Promise<Profile>;
  refresh(token: string): Promise<SessionRecord>;
  revoke(token: string): Promise<void>;
}

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}

export function resolveAuthConfig(flag?: string, origin?: string, platform = 'web'): AuthConfig {
  if (platform !== 'ios' && platform !== 'android') {
    return { enabled: false, reason: 'Autentificarea acestui pilot este disponibilă numai pe Android și iPhone. Previzualizarea web nu salvează sesiuni.' };
  }
  if (flag !== '1') {
    return { enabled: false, reason: 'Autentificarea mobilă este în pregătire. O activăm după publicarea și verificarea backendului compatibil.' };
  }
  try {
    if (!origin || origin !== origin.trim()) throw new Error();
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || !url.hostname.includes('.') || url.hostname.includes('*') ||
        /[\\\s]/.test(origin) || origin.includes('?') || origin.includes('#')) throw new Error();
    return { enabled: true, origin: url.origin };
  } catch {
    return { enabled: false, reason: 'Lipsește adresa HTTPS validă a backendului mobil verificat. Nu au fost trimise date de autentificare.' };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('invalid_response');
  return value as Record<string, unknown>;
}

export function parseSession(value: unknown, now = Date.now()): SessionRecord {
  const data = object(value);
  if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token) ||
      typeof data.expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.expiresAt) ||
      !Number.isFinite(Date.parse(data.expiresAt))) throw new AuthError('invalid_response');
  if (Date.parse(data.expiresAt) <= now) throw new AuthError('expired');
  return { token: data.token, expiresAt: data.expiresAt };
}

function tokenResponse(value: unknown): SessionRecord {
  const data = object(value);
  if (data.success !== true) throw new AuthError('invalid_response');
  return parseSession({ token: data.access_token, expiresAt: data.expires_at });
}

export function parseProfile(value: unknown): Profile {
  const data = object(value);
  if (data.ok !== true) throw new AuthError('invalid_response');
  const user = object(data.user);
  if (typeof user.userId !== 'string' || !user.userId.trim() || user.userId.length > 128 ||
      !['shopper', 'creator', 'seller', 'admin'].includes(String(user.role)) ||
      !(user.email === null || (typeof user.email === 'string' && user.email.length <= 254)) ||
      !(user.displayName === null || (typeof user.displayName === 'string' && user.displayName.length <= 256))) {
    throw new AuthError('invalid_response');
  }
  return { userId: user.userId, role: user.role as Profile['role'], email: user.email, displayName: user.displayName };
}

/** Only four fixed endpoints. Tokens cannot be attached to arbitrary URLs or redirects. */
export function createAuthApi(config: AuthConfig, fetcher: typeof fetch = fetch, timeoutMs = 15_000): AuthApi {
  async function request(path: string, token?: string, body?: unknown): Promise<unknown> {
    if (!config.enabled) throw new AuthError('disabled');
    if (token !== undefined && !/^[a-f0-9]{64}$/.test(token)) throw new AuthError('invalid_token');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${config.origin}${path}`, {
        method: path === '/api/auth/me' ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.redirected) throw new AuthError('invalid_response');
      if (response.status === 401) throw new AuthError('unauthorized');
      if (response.status === 403) throw new AuthError('forbidden');
      if (response.status === 429) throw new AuthError('rate_limited');
      if (!response.ok) throw new AuthError('server');
      try { return await response.json(); } catch { throw new AuthError('invalid_response'); }
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(controller.signal.aborted ? 'timeout' : 'network');
    } finally { clearTimeout(timer); }
  }
  return {
    inferenceOrigin: config.enabled ? config.origin : undefined,
    async login(email, password) {
      const normalized = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254 ||
          password.length < 8 || password.length > 200) throw new AuthError('invalid_input');
      return tokenResponse(await request('/api/auth/token', undefined, { email: normalized, password }));
    },
    async profile(token) { return parseProfile(await request('/api/auth/me', token)); },
    async refresh(token) { return tokenResponse(await request('/api/auth/token/refresh', token)); },
    async revoke(token) {
      const data = object(await request('/api/auth/token/revoke', token));
      if (data.success !== true) throw new AuthError('invalid_response');
    },
  };
}

function message(error: unknown): string {
  const code = error instanceof AuthError ? error.code : 'storage';
  const messages: Record<string, string> = {
    invalid_input: 'Verifică adresa de email și parola (minimum 8 caractere).',
    unauthorized: 'Sesiunea nu mai este validă sau datele de autentificare sunt incorecte.',
    forbidden: 'Acest cont nu poate fi autentificat. Contactează echipa de suport.',
    rate_limited: 'Prea multe încercări. Încearcă din nou mai târziu.',
    network: 'Conexiunea nu este disponibilă. Verifică internetul și încearcă din nou.',
    timeout: 'Serverul nu a răspuns la timp. Încearcă din nou.',
    server: 'Serviciul de autentificare este momentan indisponibil.',
    invalid_response: 'Backendul nu a returnat o sesiune compatibilă. Autentificarea a fost oprită.',
    expired: 'Sesiunea a expirat. Autentifică-te din nou.',
    disabled: 'Autentificarea mobilă nu este activată.',
    storage: 'Stocarea securizată nu este disponibilă. Sesiunea nu a fost confirmată.',
  };
  return messages[code] ?? messages.storage;
}

/** Serializes storage and invalidates late responses so logout cannot resurrect a session. */
export class AuthController {
  private api: AuthApi;
  private storage: SessionStorage;
  private enabled: boolean;
  private now: () => number;
  private epoch = 0;
  private record: SessionRecord | null = null;
  private ownerId: string | undefined;
  private state: AuthState = { status: 'signed-out', user: null };
  private listeners = new Set<(state: AuthState) => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private refreshFlight: { epoch: number; task: Promise<void> } | null = null;
  private readValidationEpoch: number | undefined;
  private validationFlight: { epoch: number; task: Promise<void> } | null = null;

  constructor(api: AuthApi, storage: SessionStorage, enabled: boolean, now = Date.now) {
    this.api = api; this.storage = storage; this.enabled = enabled; this.now = now;
  }
  getState(): AuthState { return this.state; }
  /** Fixed-path, same-origin request capability; credentials never leave this controller.
   * Cancellation may use its captured credential after local invalidation, only for
   * requests actually issued by this lease. Revoked server credentials still fail closed.
   */
  authorizeInference(fetcher: typeof fetch = fetch): InferenceLease {
    const origin = this.api.inferenceOrigin;
    const record = this.record;
    const epoch = this.epoch;
    const userId = this.ownerId;
    if (!this.enabled || !origin || !record || !userId || this.state.status !== 'authenticated' ||
        !resolveAuthConfig('1', origin, 'android').enabled) throw new AuthError('disabled');
    parseSession(record, this.now());
    let closed = false;
    const issued = new Map<string, string>();
    const active = new Map<AbortController, boolean>();
    const disposers = new Set<() => void>();
    const current = () => !closed && this.epoch === epoch && this.record === record &&
      this.ownerId === userId && this.state.status === 'authenticated' && Date.parse(record.expiresAt) > this.now();
    const request = async (path: '/api/ilaria/infer' | '/api/ilaria/cancel', body: string,
      signal: AbortSignal | undefined, cancelling: boolean): Promise<Response> => {
      if ((!cancelling && !current()) || signal?.aborted) throw new AuthError('expired');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      active.set(controller, cancelling);
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller); disposers.delete(cleanup);
      };
      const timer = setTimeout(() => { abort(); cleanup(); }, cancelling ? 2000 : Math.min(30_000, Math.max(1, Date.parse(record.expiresAt) - this.now())));
      disposers.add(cleanup);
      let delivered = false;
      let rejectAborted: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          rejectAborted = () => reject(new AuthError('timeout'));
          controller.signal.addEventListener('abort', rejectAborted, { once: true });
          if (controller.signal.aborted) rejectAborted();
        });
        const response = await Promise.race([fetcher(origin + path, { method: 'POST', body,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + record.token },
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal }), cancelled]);
        if (response.redirected) throw new AuthError('invalid_response');
        if (!cancelling && !current()) throw new AuthError('expired');
        delivered = true;
        return response;
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError(controller.signal.aborted ? 'timeout' : 'network');
      } finally {
        if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
        if (!delivered) cleanup();
      }
    };
    const unsubscribe = this.subscribe(() => {
      if (!current()) for (const [controller, cancelling] of active) if (!cancelling) controller.abort();
    });
    return {
      userId, isCurrent: current,
      infer: (taskId, body, signal) => {
        let bodyBytes: number;
        try { bodyBytes = encodeURIComponent(body).replace(/%[0-9A-F]{2}/g, 'x').length; }
        catch { return Promise.reject(new AuthError('invalid_input')); }
        if (!current() || !/^[A-Za-z0-9_.:-]{1,128}$/.test(taskId) || taskId.trim() !== taskId || bodyBytes > 65536 ||
            issued.size !== 0 || signal.aborted) return Promise.reject(new AuthError('invalid_input'));
        issued.set(taskId, body);
        return request('/api/ilaria/infer', body, signal, false);
      },
      cancel: (taskId, signal) => {
        const body = issued.get(taskId);
        if (body === undefined) return Promise.reject(new AuthError('invalid_input'));
        return request('/api/ilaria/cancel', body, signal, true);
      },
      close: () => {
        closed = true; unsubscribe(); for (const controller of active.keys()) controller.abort();
        for (const cleanup of disposers) cleanup(); issued.clear();
      },
    };
  }
  /** A deadline only: lifecycle consumers never receive the credential. */
  getSessionExpiresAt(): number | null {
    // A pending mutation owns its candidate; an old deadline must not cancel rotation.
    if (!this.record || (this.state.status === 'loading' && this.readValidationEpoch !== this.epoch)) return null;
    return Date.parse(this.record.expiresAt);
  }
  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(state: AuthState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  private persist(record: SessionRecord | null, epoch: number): Promise<void> {
    const task = this.writes.then(async () => {
      // Owned deletion stays ordered even if a later sign-in starts while it is queued.
      if (record) {
        if (this.epoch !== epoch) return;
        parseSession(record, this.now());
      }
      await this.storage.write(record ? JSON.stringify(record) : null);
    });
    this.writes = task.catch(() => undefined);
    return task;
  }
  private async revokeQuietly(token: string): Promise<boolean> {
    try { await this.api.revoke(token); return true; } catch { return false; }
  }
  private async fail(error: unknown, epoch: number, candidate?: SessionRecord) {
    const cleanup = candidate ? this.revokeQuietly(candidate.token) : Promise.resolve(true);
    if (epoch !== this.epoch) { await cleanup; return; }
    this.record = null;
    this.ownerId = undefined;
    this.emit({ status: 'error', user: null, message: message(error) });
    // Local invalidation and ordered deletion never wait for uncertain remote cleanup.
    try { await this.persist(null, epoch); }
    catch (storageError) {
      if (epoch === this.epoch) this.emit({ status: 'error', user: null, message: message(storageError) });
    }
    await cleanup;
  }
  private async accept(record: SessionRecord, epoch: number, expectedId?: string) {
    if (epoch !== this.epoch) { await this.revokeQuietly(record.token); return; }
    const user = await this.api.profile(record.token);
    if (expectedId && expectedId !== user.userId) throw new AuthError('invalid_response');
    if (epoch !== this.epoch) { await this.revokeQuietly(record.token); return; }
    parseSession(record, this.now());
    await this.persist(record, epoch);
    if (epoch !== this.epoch) { await this.revokeQuietly(record.token); return; }
    parseSession(record, this.now());
    this.record = record;
    this.ownerId = user.userId;
    this.emit({ status: 'authenticated', user });
  }

  async restore(): Promise<void> {
    if (!this.enabled) return;
    const epoch = ++this.epoch;
    this.readValidationEpoch = epoch;
    this.emit({ status: 'loading', user: null });
    let record: SessionRecord | null = null;
    try {
      await this.writes;
      const stored = await this.storage.read();
      if (epoch !== this.epoch) return;
      if (!stored) { this.record = null; this.ownerId = undefined; this.emit({ status: 'signed-out', user: null }); return; }
      try { record = parseSession(JSON.parse(stored), this.now()); }
      catch (error) { throw error instanceof AuthError ? error : new AuthError('invalid_response'); }
      this.record = record;
      this.emit({ status: 'loading', user: null }); // Publish only the retained deadline.
      const user = await this.api.profile(record.token);
      if (epoch !== this.epoch) return;
      parseSession(record, this.now());
      if (this.ownerId && this.ownerId !== user.userId) throw new AuthError('invalid_response');
      this.ownerId = user.userId;
      this.emit({ status: 'authenticated', user });
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (record && error instanceof AuthError && ['network', 'timeout', 'server', 'rate_limited'].includes(error.code)) {
        // The response can arrive after the token deadline, including a network failure.
        try { parseSession(record, this.now()); }
        catch (expired) { await this.fail(expired, epoch); return; }
        this.emit({ status: 'offline', user: null, message: message(error) });
      } else { await this.fail(error, epoch); }
    }
  }

  /** Re-check a retained credential on foreground; never rotate or rewrite it. */
  revalidate(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.validationFlight?.epoch === this.epoch) return this.validationFlight.task;
    // Lifecycle waits for the owning login/rotation/logout instead of cancelling it.
    if (this.state.status === 'loading' || !this.record) return Promise.resolve();
    const record = this.record;
    const expectedId = this.ownerId;
    const epoch = ++this.epoch;
    this.readValidationEpoch = epoch;
    const task = this.validateRetained(record, epoch, expectedId).finally(() => {
      if (this.validationFlight?.task === task) this.validationFlight = null;
    });
    this.validationFlight = { epoch, task };
    return task;
  }
  /** A new foreground must not join a validation owned by an earlier observer. */
  waitForRevalidation(): Promise<void> {
    return this.validationFlight?.epoch === this.epoch ? this.validationFlight.task : Promise.resolve();
  }
  private async validateRetained(record: SessionRecord, epoch: number, expectedId?: string): Promise<void> {
    this.emit({ status: 'loading', user: null });
    try {
      parseSession(record, this.now());
      const user = await this.api.profile(record.token);
      if (epoch !== this.epoch) return;
      parseSession(record, this.now());
      if (expectedId && user.userId !== expectedId) throw new AuthError('invalid_response');
      this.ownerId = user.userId;
      this.emit({ status: 'authenticated', user });
    } catch (error) {
      if (epoch !== this.epoch) return;
      let failure = error;
      try { parseSession(record, this.now()); } catch (expired) { failure = expired; }
      if (failure instanceof AuthError && ['network', 'timeout', 'server', 'rate_limited'].includes(failure.code)) {
        this.emit({ status: 'offline', user: null, message: message(failure) });
      } else { await this.fail(failure, epoch); }
    }
  }

  /** Hide expired evidence synchronously, before any secure-storage I/O. */
  async expireIfNeeded(): Promise<void> {
    if (!this.enabled || !this.record) return;
    let failure: unknown;
    try { parseSession(this.record, this.now()); return; } catch (error) { failure = error; }
    const epoch = ++this.epoch;
    this.record = null;
    this.ownerId = undefined;
    this.emit({ status: 'error', user: null, message: message(failure) });
    try { await this.persist(null, epoch); }
    catch (error) {
      if (epoch === this.epoch) this.emit({ status: 'error', user: null, message: message(error) });
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.enabled) return;
    const epoch = ++this.epoch;
    this.emit({ status: 'loading', user: null });
    let candidate: SessionRecord | undefined;
    try {
      candidate = parseSession(await this.api.login(email, password), this.now());
      await this.accept(candidate, epoch);
    } catch (error) { await this.fail(error, epoch, candidate); }
  }

  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.refreshFlight?.epoch === this.epoch) return this.refreshFlight.task;
    const task = this.rotate().finally(() => {
      if (this.refreshFlight?.task === task) this.refreshFlight = null;
    });
    this.refreshFlight = { epoch: this.epoch, task };
    return task;
  }
  private async rotate(): Promise<void> {
    const record = this.record;
    const expectedId = this.ownerId;
    const epoch = ++this.epoch;
    if (!record) { this.emit({ status: 'signed-out', user: null }); return; }
    this.emit({ status: 'loading', user: null });
    let candidate: SessionRecord | undefined;
    try {
      parseSession(record, this.now());
      candidate = parseSession(await this.api.refresh(record.token), this.now());
      if (candidate.token === record.token) throw new AuthError('invalid_response');
      await this.accept(candidate, epoch, expectedId);
    } catch (error) {
      // A lost response may mean the old token was consumed. Never retry that refresh automatically.
      await this.fail(error, epoch, candidate);
    }
  }

  async signOut(): Promise<void> {
    if (!this.enabled) return;
    const epoch = ++this.epoch;
    const record = this.record;
    this.record = null;
    this.ownerId = undefined;
    this.emit({ status: 'loading', user: null });
    let cleared = true;
    try { await this.persist(null, epoch); } catch { cleared = false; }
    const revoked = record ? await this.revokeQuietly(record.token) : true;
    if (epoch !== this.epoch) return;
    this.emit({ status: cleared ? 'signed-out' : 'error', user: null, message: !cleared
      ? 'Profilul a fost închis, dar ștergerea stocării securizate a eșuat. Nu considera dispozitivul deconectat definitiv.'
      : !revoked ? 'Sesiunea a fost eliminată de pe dispozitiv. Revocarea pe server nu a putut fi confirmată.'
        : 'Ai fost deconectat.' });
  }
}
