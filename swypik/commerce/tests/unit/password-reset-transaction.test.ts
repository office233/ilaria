import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({transaction:vi.fn(),query:vi.fn()}));
vi.mock('@/lib/db',()=>({withTransaction:mocks.transaction}));
import {resetPasswordWithToken} from '@/lib/auth/reset-password';
beforeEach(()=>{vi.resetAllMocks();mocks.transaction.mockImplementation((fn)=>fn(mocks.query));});
describe('password reset transaction',()=>{
 it('consumes the token and changes password and sessions using the same transaction',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{user_id:'u'}]}).mockResolvedValue({rows:[]});
  expect(await resetPasswordWithToken('token-hash','password-hash')).toBe(true);
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.query).toHaveBeenCalledTimes(3);
  expect(mocks.query.mock.calls[0][0]).toContain('used_at IS NULL AND expires_at > now()');
  expect(mocks.query.mock.calls[1][1]).toEqual(['password-hash','u']);
  expect(mocks.query.mock.calls[2][1]).toEqual(['u']);
 });
 it('does not change password or sessions for a consumed or expired token',async()=>{
  mocks.query.mockResolvedValue({rows:[]});
  expect(await resetPasswordWithToken('used','password')).toBe(false);
  expect(mocks.query).toHaveBeenCalledTimes(1);
 });
 it('propagates session revocation failure so the transaction helper rolls back everything',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{user_id:'u'}]}).mockResolvedValueOnce({rows:[]}).mockRejectedValueOnce(new Error('database failed'));
  await expect(resetPasswordWithToken('token','password')).rejects.toThrow('database failed');
 });
});
