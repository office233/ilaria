import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({send:vi.fn(),provider:vi.fn(),warn:vi.fn()}));
vi.mock('@/lib/email/transport',()=>({sendMail:mocks.send,activeProvider:mocks.provider}));
vi.mock('@/lib/db',()=>({dbQuery:vi.fn()}));
vi.mock('@/lib/feature-flags',()=>({isEnabled:vi.fn()}));
vi.mock('@/lib/app-url',()=>({APP_URL:'https://swypik.com'}));
vi.mock('@/lib/contact',()=>({SUPPORT_EMAIL:'support@swypik.com'}));
vi.mock('@/lib/logger',()=>({logger:{child:()=>({warn:mocks.warn,error:vi.fn(),info:vi.fn()}),error:vi.fn(),warn:vi.fn()}}));
import {sendMagicLink,sendEmail} from '@/lib/email/service';
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('NODE_ENV','production');vi.stubEnv('SESSION_SECRET','test-only-secret');});
afterEach(()=>vi.unstubAllEnvs());
describe('truthful email delivery status',()=>{
 it('does not report OTP delivery without an email provider',async()=>{
  mocks.provider.mockReturnValue('none');
  expect(await sendMagicLink('u@example.com','123456')).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('123456');
 });
 it('propagates provider rejection for an OTP',async()=>{
  mocks.provider.mockReturnValue('resend');mocks.send.mockResolvedValue(false);
  expect(await sendMagicLink('u@example.com','123456')).toBe(false);
 });
 it('reports success when a provider accepts the OTP',async()=>{
  mocks.provider.mockReturnValue('smtp');mocks.send.mockResolvedValue(true);
  expect(await sendMagicLink('u@example.com','123456')).toBe(true);
 });
 it('does not report transactional email delivery without a provider',async()=>{
  mocks.provider.mockReturnValue('none');
  expect(await sendEmail({to:'u@example.com',subject:'Reset',html:'Reset password'})).toBe(false);
 });
});
