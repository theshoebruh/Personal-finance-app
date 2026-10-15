import { BuildEnvError, checkBuildEnv, type BuildEnvInput } from './buildEnv';

const URL_OK = 'https://abcdefghijklmnop.supabase.co';
const KEY_OK = 'sb_publishable_example';
const prod = (over: Partial<BuildEnvInput> = {}): BuildEnvInput => ({
  command: 'build',
  mode: 'production',
  url: URL_OK,
  key: KEY_OK,
  allowLocalOnly: undefined,
  ...over,
});

const jwt = (payload: object) =>
  `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

describe('build environment checks', () => {
  it('accepts a production build with both values', () => {
    expect(checkBuildEnv(prod())).toEqual({ url: URL_OK, key: KEY_OK, localOnly: false });
  });

  it('fails a production build when both values are missing', () => {
    expect(() => checkBuildEnv(prod({ url: undefined, key: undefined }))).toThrow(BuildEnvError);
    expect(() => checkBuildEnv(prod({ url: '', key: '  ' }))).toThrow(/not set/);
  });

  it('fails whenever only one value is set', () => {
    expect(() => checkBuildEnv(prod({ key: undefined }))).toThrow(
      /VITE_SUPABASE_PUBLISHABLE_KEY is missing/,
    );
    expect(() => checkBuildEnv(prod({ url: '' }))).toThrow(/VITE_SUPABASE_URL is missing/);
    expect(() => checkBuildEnv(prod({ url: '', allowLocalOnly: 'true' }))).toThrow(
      /VITE_SUPABASE_URL is missing/,
    );
  });

  it('allows a deliberate local-only build', () => {
    expect(checkBuildEnv(prod({ url: '', key: '', allowLocalOnly: 'true' }))).toMatchObject({
      localOnly: true,
    });
    expect(() => checkBuildEnv(prod({ url: '', key: '', allowLocalOnly: '1' }))).toThrow(/not set/);
  });

  it('does not require the values for the dev server, tests or other modes', () => {
    expect(checkBuildEnv(prod({ command: 'serve', url: '', key: '' })).localOnly).toBe(true);
    expect(checkBuildEnv(prod({ mode: 'test', url: '', key: '' })).localOnly).toBe(true);
    expect(checkBuildEnv(prod({ mode: 'artifact', url: '', key: '' })).localOnly).toBe(true);
  });

  it('never allows a secret or service-role key, in any mode', () => {
    expect(() => checkBuildEnv(prod({ key: 'sb_secret_abc' }))).toThrow(/secret/);
    expect(() => checkBuildEnv(prod({ key: jwt({ role: 'service_role' }) }))).toThrow(/secret/);
    expect(() => checkBuildEnv(prod({ command: 'serve', key: 'sb_secret_abc' }))).toThrow(/secret/);
    expect(checkBuildEnv(prod({ key: jwt({ role: 'anon' }) })).localOnly).toBe(false);
  });

  it('requires https in production, except localhost', () => {
    expect(() => checkBuildEnv(prod({ url: 'http://example.com' }))).toThrow(/https/);
    expect(() => checkBuildEnv(prod({ url: 'not a url' }))).toThrow(/valid URL/);
    expect(checkBuildEnv(prod({ url: 'http://127.0.0.1:54321' })).localOnly).toBe(false);
    expect(checkBuildEnv(prod({ command: 'serve', url: 'http://example.com' })).localOnly).toBe(
      false,
    );
  });
});
