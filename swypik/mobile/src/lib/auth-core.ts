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
export interface AuthApi {
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
  private state: AuthState = { status: 'signed-out', user: null };
  private listeners = new Set<(state: AuthState) => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private refreshFlight: Promise<void> | null = null;

  constructor(api: AuthApi, storage: SessionStorage, enabled: boolean, now = Date.now) {
    this.api = api; this.storage = storage; this.enabled = enabled; this.now = now;
  }
  getState(): AuthState { return this.state; }
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
      if (this.epoch !== epoch) return;
      await this.storage.write(record ? JSON.stringify(record) : null);
    });
    this.writes = task.catch(() => undefined);
    return task;
  }
  private async revokeQuietly(token: string): Promise<boolean> {
    try { await this.api.revoke(token); return true; } catch { return false; }
  }
  private async fail(error: unknown, epoch: number, candidate?: SessionRecord) {
    if (candidate) await this.revokeQuietly(candidate.token);
    if (epoch !== this.epoch) return;
    this.record = null;
    let text = message(error);
    try { await this.persist(null, epoch); } catch { text = message(new Error('storage')); }
    if (epoch === this.epoch) this.emit({ status: 'error', user: null, message: text });
  }
  private async accept(record: SessionRecord, epoch: number, expectedId?: string) {
    if (epoch !== this.epoch) { await this.revokeQuietly(record.token); return; }
    const user = await this.api.profile(record.token);
    if (expectedId && expectedId !== user.userId) throw new AuthError('invalid_response');
    if (epoch !== this.epoch) { await this.revokeQuietly(record.token); return; }
    await this.persist(record, epoch);
    if (epoch !== this.epoch) { await this.revokeQuietly(record.token); return; }
    this.record = record;
    this.emit({ status: 'authenticated', user });
  }

  async restore(): Promise<void> {
    if (!this.enabled) return;
    const epoch = ++this.epoch;
    this.emit({ status: 'loading', user: null });
    let record: SessionRecord | null = null;
    try {
      await this.writes;
      const stored = await this.storage.read();
      if (epoch !== this.epoch) return;
      if (!stored) { this.record = null; this.emit({ status: 'signed-out', user: null }); return; }
      try { record = parseSession(JSON.parse(stored), this.now()); }
      catch (error) { throw error instanceof AuthError ? error : new AuthError('invalid_response'); }
      this.record = record;
      const user = await this.api.profile(record.token);
      if (epoch === this.epoch) this.emit({ status: 'authenticated', user });
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (record && error instanceof AuthError && ['network', 'timeout', 'server', 'rate_limited'].includes(error.code)) {
        // Keep the token for an explicit retry, but never expose an unvalidated cached identity.
        this.emit({ status: 'offline', user: null, message: message(error) });
      } else { await this.fail(error, epoch); }
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
    if (this.refreshFlight) return this.refreshFlight;
    const task = this.rotate().finally(() => {
      if (this.refreshFlight === task) this.refreshFlight = null;
    });
    this.refreshFlight = task;
    return task;
  }
  private async rotate(): Promise<void> {
    const record = this.record;
    const user = this.state.user;
    const epoch = ++this.epoch;
    if (!record) { this.emit({ status: 'signed-out', user: null }); return; }
    this.emit({ status: 'loading', user });
    let candidate: SessionRecord | undefined;
    try {
      parseSession(record, this.now());
      candidate = parseSession(await this.api.refresh(record.token), this.now());
      if (candidate.token === record.token) throw new AuthError('invalid_response');
      await this.accept(candidate, epoch, user?.userId);
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
