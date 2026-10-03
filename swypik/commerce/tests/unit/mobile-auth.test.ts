import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn(), auth: vi.fn(), session: vi.fn(), limit: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/db', () => ({ dbQuery: mocks.db }));
vi.mock('@/lib/auth/getAuthUser', () => ({ getAuthUser: mocks.auth }));
vi.mock('@/lib/auth/session', () => ({ getAuthSession: mocks.session, hashSessionToken: (s: string) => 'hash:' + s, isSessionTokenFormat: (s: string) => /^[a-f0-9]{64}$/.test(s) }));
vi.mock('@/lib/security/rate-limit', () => ({rateLimit: mocks.limit, getClientIP: () => '127.0.0.1'}));
vi.mock('@/lib/logger', () => ({logger:{info:vi.fn(),error:vi.fn(),warn:vi.fn()}}));
vi.mock('bcryptjs', () => ({default:{compare:mocks.compare}}));
import { GET } from '@/app/api/auth/me/route';
import { POST as refresh } from '@/app/api/auth/token/refresh/route';
import { POST as login } from '@/app/api/auth/token/route';
const guest = {role:'guest',userId:null,email:null,sellerId:null,isAdmin:false};
beforeEach(() => {vi.resetAllMocks();mocks.auth.mockResolvedValue(guest);mocks.session.mockResolvedValue(null);mocks.db.mockResolvedValue({rows:[]});mocks.limit.mockResolvedValue({success:true});mocks.compare.mockResolvedValue(true);});
describe('mobile identity', () => {
 it('returns bearer identity and profile', async () => {
  mocks.session.mockResolvedValue({userId:'u',role:'shopper',email:'u@example.com'});
  mocks.db.mockResolvedValue({rows:[{username:'name',display_name:'Name',avatar_url:null}]});
  const r=await GET(); expect(r.status).toBe(200); expect((await r.json()).user).toMatchObject({userId:'u',username:'name',isAdmin:false,sellerId:null}); expect(r.headers.get('cache-control')).toContain('no-store');
 });
 it('rejects invalid/expired bearer sessions', async () => {expect((await GET()).status).toBe(401);expect(mocks.db).not.toHaveBeenCalled();});
 it.each(['seller','admin'])('preserves existing %s cookie identity', async role => {
  mocks.auth.mockResolvedValue({...guest,role,userId:'cookie',isAdmin:role==='admin',sellerId:role==='seller'?'seller':null});
  const r=await GET();expect((await r.json()).user.userId).toBe('cookie');expect(mocks.session).not.toHaveBeenCalled();
 });
 it('does not merge a seller-only session with an unrelated bearer', async () => {mocks.auth.mockResolvedValue({...guest,role:'seller',sellerId:'s'});expect((await GET()).status).toBe(401);expect(mocks.session).not.toHaveBeenCalled();});
});
describe('mobile token lifecycle', () => {
 const req = (token: string) => new Request('https://swypik.com/api/auth/token/refresh',{method:'POST',headers:{Authorization:'Bearer '+token}});
 it('rejects malformed tokens before database access', async () => {expect((await refresh(req('otp:123456'))).status).toBe(401);expect(mocks.db).not.toHaveBeenCalled();});
 it('returns 401 when token cannot be consumed', async () => {expect((await refresh(req('a'.repeat(64)))).status).toBe(401);});
 it('returns a new token only when the atomic statement succeeds', async () => {
 mocks.db.mockResolvedValue({rows:[{user_id:'u',expires_at:'future'}]});const r=await refresh(req('a'.repeat(64)));const b=await r.json();expect(r.status).toBe(200);expect(b.access_token).toMatch(/^[0-9a-f]{64}$/);expect(b.access_token).not.toBe('a'.repeat(64));expect(mocks.db).toHaveBeenCalledTimes(1);
 });
 it('does not return a token after database failure', async () => {mocks.db.mockRejectedValue(new Error('insert failed'));const r=await refresh(req('a'.repeat(64)));expect(r.status).toBe(500);expect(await r.json()).not.toHaveProperty('access_token');});
 it.each([{status:'banned',suspended_until:null},{status:'suspended',suspended_until:null},{status:'deleted',suspended_until:null},{status:'active',suspended_until:'2999-01-01'}])('blocks restricted accounts at login: %o', async state => {
 mocks.db.mockResolvedValue({rows:[{id:'u',password_hash:'hash',role:'shopper',...state}]});
 const r=await login(new Request('https://swypik.com/api/auth/token',{method:'POST',body:JSON.stringify({email:'u@example.com',password:'password123'})}));expect(r.status).toBe(403);expect(mocks.db).toHaveBeenCalledTimes(1);
 });
});

describe('mobile auth hardening', () => {
 const request = () => new Request('https://swypik.com/api/auth/token', {method:'POST',body:JSON.stringify({email:'u@example.com',password:'password123'})});
 it('does not bypass the second factor via password-only token login', async () => {
  mocks.db.mockResolvedValue({rows:[{id:'u',password_hash:'hash',status:'active',role:'shopper',suspended_until:null,totp_enabled_at:'2026-01-01'}]});
  const response = await login(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({success:false,error:'two_factor_required'});
  expect(mocks.compare).toHaveBeenCalledTimes(1);
  expect(mocks.db).toHaveBeenCalledTimes(1);
 });
 it('keeps login working for accounts without TOTP and prohibits caching tokens', async () => {
  mocks.db.mockResolvedValueOnce({rows:[{id:'u',password_hash:'hash',status:'active',role:'shopper',suspended_until:null,totp_enabled_at:null}]})
    .mockResolvedValueOnce({rows:[{expires_at:'future'}]});
  const response = await login(request());
  expect(response.status).toBe(200);
  expect((await response.json()).access_token).toMatch(/^[0-9a-f]{64}$/);
  expect(response.headers.get('cache-control')).toBe('no-store');
 });
 it('prohibits caching refreshed credentials', async () => {
  mocks.db.mockResolvedValue({rows:[{user_id:'u',expires_at:'future'}]});
  const response = await refresh(new Request('https://swypik.com/api/auth/token/refresh',{method:'POST',headers:{Authorization:'Bearer '+'a'.repeat(64)}}));
  expect(response.headers.get('cache-control')).toBe('no-store');
 });
});
