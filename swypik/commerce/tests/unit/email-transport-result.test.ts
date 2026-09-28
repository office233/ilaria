import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@/lib/logger',()=>({logger:{child:()=>({warn:vi.fn(),error:vi.fn()})}}));
import {sendMail} from '@/lib/email/transport';
afterEach(()=>vi.unstubAllEnvs());
it('returns a failure when no transport can accept mail',async()=>{
 vi.stubEnv('RESEND_API_KEY','placeholder');vi.stubEnv('SMTP_HOST','');
 expect(await sendMail({to:'u@example.com',subject:'OTP',html:'test'})).toBe(false);
});
