import {beforeEach,describe,expect,it,vi} from 'vitest';
const db = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({dbQuery:db}));
vi.mock('@/lib/auth/session', () => ({hashSessionToken:vi.fn()}));
vi.mock('@/lib/app-url', () => ({APP_URL:'https://swypik.com'}));
vi.mock('@/lib/logger', () => ({logger:{warn:vi.fn()}}));
vi.mock('@/lib/referral/attribution', () => ({attributeOnSignup:vi.fn()}));
vi.mock('@/lib/risk/recreation-detection', () => ({checkRecreationAndMaybeBlock:vi.fn().mockResolvedValue({blocked:false})}));
import {findOrCreateUserFromOAuth, type OAuthProfile} from '@/lib/auth/oauth/helpers';
const profile:OAuthProfile={provider:'google',providerUserId:'subject',email:'victim@example.com',emailVerified:false,displayName:'Name',avatarUrl:null};
beforeEach(()=>{db.mockReset();});
describe('OAuth email ownership',()=>{
 it('never links an unverified provider email to an existing local account',async()=>{
  db.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'new-provider-user'}]}).mockResolvedValue({rows:[]});
  expect(await findOrCreateUserFromOAuth(profile)).toEqual({userId:'new-provider-user',recreationBlocked:false});
  expect(db.mock.calls.some(([sql])=>sql.includes('WHERE lower(email)'))).toBe(false);
  const insert=db.mock.calls.find(([sql])=>sql.includes('INSERT INTO users'));
  expect(insert?.[1][1]).toBeNull();
  expect(db.mock.calls.find(([sql])=>sql.includes('INSERT INTO oauth_accounts'))?.[1]).toEqual(['new-provider-user','google','subject',null]);
 });
 it('links an existing account only when provider verifies its email',async()=>{
  db.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{id:'existing'}]}).mockResolvedValue({rows:[]});
  expect((await findOrCreateUserFromOAuth({...profile,emailVerified:true})).userId).toBe('existing');
  expect(db.mock.calls.some(([sql])=>sql.includes('INSERT INTO users'))).toBe(false);
 });
 it('keeps repeat login working through the previously verified provider subject',async()=>{
  db.mockResolvedValue({rows:[{user_id:'linked'}]});
  expect((await findOrCreateUserFromOAuth({...profile,email:null})).userId).toBe('linked');
  expect(db).toHaveBeenCalledTimes(1);
 });
});
