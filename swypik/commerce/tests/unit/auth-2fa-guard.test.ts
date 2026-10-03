import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({db:vi.fn(),limit:vi.fn(),get:vi.fn(),del:vi.fn(),set:vi.fn(),verify:vi.fn(),backup:vi.fn()}));
vi.mock('@/lib/db',()=>({dbQuery:mocks.db}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined})}));
vi.mock('@/lib/email/service',()=>({sendMagicLink:vi.fn(),sendEmail:vi.fn(),sendWelcomeEmail:vi.fn()}));
vi.mock('@/lib/security/rate-limit',()=>({rateLimit:mocks.limit,getClientIP:()=> 'ip'}));
vi.mock('@/lib/logger',()=>({logger:{child:()=>({info:vi.fn()}),warn:vi.fn(),error:vi.fn()}}));
vi.mock('@/lib/referral/attribution',()=>({attributeOnSignup:vi.fn()}));
vi.mock('@/lib/auth/session',()=>({hashSessionToken:vi.fn(),resolvePostLoginRedirect:vi.fn()}));
vi.mock('@/lib/security/admin-auth',()=>({createAdminSessionAndGetCookie:vi.fn(),revokeAdminSessionsForUser:vi.fn(),getAdminCookieName:()=> 'admin_session'}));
vi.mock('@/lib/cart/session',()=>({CART_COOKIE:'cart',mergeAnonCartToUser:vi.fn()}));
vi.mock('@/lib/social/session',()=>({getAnonShellUserId:vi.fn()}));
vi.mock('@/lib/social/merge-anon',()=>({mergeAnonSocialToUser:vi.fn()}));
vi.mock('@/lib/app-url',()=>({APP_URL:'https://swypik.com'}));
vi.mock('@/lib/redis',()=>({getRedis:()=>({get:mocks.get,del:mocks.del,set:mocks.set})}));
vi.mock('@/lib/email/templates/auth',()=>({sendPasswordResetEmail:vi.fn(),sendVerifyEmail:vi.fn(),sendWelcomeEmail:vi.fn().mockResolvedValue(true)}));
vi.mock('@/lib/auth/totp',()=>({verifyToken:mocks.verify,consumeBackupCode:mocks.backup}));
import {POST} from '@/app/api/auth/route';
const request=(tempToken='a'.repeat(64))=>new Request('https://swypik.com/api/auth',{method:'POST',body:JSON.stringify({action:'verify_2fa',tempToken,code:'123456'})});
beforeEach(()=>{vi.resetAllMocks();mocks.limit.mockResolvedValue({success:true});mocks.get.mockResolvedValue(JSON.stringify({userId:'u',email:'u@example.com',next:null}));mocks.db.mockResolvedValue({rows:[{totp_secret:'secret',totp_backup_codes:null}]});mocks.verify.mockReturnValue(true);});
describe('second-factor challenge guard',()=>{
 it('rejects malformed challenge identifiers before lookup',async()=>{
  expect((await POST(request('not-a-session'))).status).toBe(400);expect(mocks.get).not.toHaveBeenCalled();
 });
 it('limits guesses across IPs for the same challenge',async()=>{
  mocks.limit.mockResolvedValueOnce({success:true}).mockResolvedValueOnce({success:false});
  expect((await POST(request())).status).toBe(429);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.limit).toHaveBeenCalledWith('auth-2fa-challenge','a'.repeat(64),{limit:5,window:300});
 });
 it('rejects a correct code when another request already consumed the challenge',async()=>{
  mocks.del.mockResolvedValue(0);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.db).toHaveBeenCalledTimes(1);
 });
 it('rejects invalid codes without consuming the challenge',async()=>{
  mocks.verify.mockReturnValue(false);
  expect((await POST(request())).status).toBe(401);
  expect(mocks.del).not.toHaveBeenCalled();
 });
});

describe('email OTP cannot bypass MFA',()=>{
 it('answers a TOTP-enabled account with a second-factor challenge, not a session',async()=>{
  mocks.db.mockResolvedValue({rows:[{id:'otp',user_id:'u',totp_enabled_at:'2026-01-01'}]});
  const response=await POST(new Request('https://swypik.com/api/auth',{method:'POST',body:JSON.stringify({action:'verify_otp',email:'u@example.com',token:'123456'})}));
  expect(response.status).toBe(200);
  const body=await response.json();
  expect(body.requires2FA).toBe(true);
  expect(body.tempToken).toMatch(/^[0-9a-f]{64}$/);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(mocks.set).toHaveBeenCalledWith(`2fa:pending:${body.tempToken}`,expect.stringContaining('"userId":"u"'),'EX',300);
 });
 it('refuses an OTP consumed by a concurrent request',async()=>{
  mocks.db.mockResolvedValueOnce({rows:[{id:'otp',user_id:'u',totp_enabled_at:null}]}).mockResolvedValueOnce({rows:[]});
  const response=await POST(new Request('https://swypik.com/api/auth',{method:'POST',body:JSON.stringify({action:'verify_otp',email:'u@example.com',token:'123456'})}));
  expect(response.status).toBe(400);
  expect(mocks.db).toHaveBeenCalledTimes(2);
 });
});

describe('backup code single use across challenges',()=>{
 it('refuses a backup code consumed since the initial account lookup',async()=>{
  mocks.verify.mockReturnValue(false);
  mocks.db.mockResolvedValueOnce({rows:[{totp_secret:'secret',totp_backup_codes:['old-hash']}]})
    .mockResolvedValueOnce({rows:[]});
  mocks.backup.mockResolvedValue({matched:true,remaining:[]});
  const response=await POST(new Request('https://swypik.com/api/auth',{method:'POST',body:JSON.stringify({action:'verify_2fa',tempToken:'a'.repeat(64),code:'ABCDEF12'})}));
  expect(response.status).toBe(401);
  expect(mocks.db.mock.calls[1][1]).toEqual([[],'u',['old-hash']]);
  expect(mocks.del).not.toHaveBeenCalled();
 });
});
