/**
 * Build-time checks for the public Supabase settings that get embedded in the JavaScript bundle.
 * Runs from vite.config.ts; kept separate so the rules are unit-tested.
 */

export interface BuildEnvInput {
  command: 'build' | 'serve';
  mode: string;
  url: string | undefined;
  key: string | undefined;
  /** Set ALLOW_LOCAL_ONLY_BUILD=true to build the local-only app (no sign-in, no sync) on purpose. */
  allowLocalOnly: string | undefined;
}

export interface BuildEnvResult {
  url: string;
  key: string;
  /** True when the build has no Supabase settings and will run local-only. */
  localOnly: boolean;
}

export class BuildEnvError extends Error {
  name = 'BuildEnvError';
}

function isServiceRoleJwt(key: string): boolean {
  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role?: string;
    };
    return json.role === 'service_role';
  } catch {
    return false;
  }
}

/**
 * - Never allows a secret / service-role key (it would be readable by every visitor).
 * - Production builds (`vite build`, mode "production") must have both variables, so a deployment
 *   with missing settings fails instead of silently shipping the local-only app. Building the
 *   local-only app on purpose needs ALLOW_LOCAL_ONLY_BUILD=true.
 * - Setting only one of the two variables is always an error.
 * - Production builds must use an https URL (localhost is allowed for local testing).
 */
export function checkBuildEnv(input: BuildEnvInput): BuildEnvResult {
  const url = (input.url ?? '').trim();
  const key = (input.key ?? '').trim();

  if (key.startsWith('sb_secret_') || isServiceRoleJwt(key)) {
    throw new BuildEnvError(
      'VITE_SUPABASE_PUBLISHABLE_KEY is a secret (service-role) key. Use the publishable key from ' +
        'Supabase → Project Settings → API keys. Never put a secret key in frontend settings.',
    );
  }

  if (Boolean(url) !== Boolean(key)) {
    const missing = url ? 'VITE_SUPABASE_PUBLISHABLE_KEY' : 'VITE_SUPABASE_URL';
    throw new BuildEnvError(
      `${missing} is missing. Set both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, or neither.`,
    );
  }

  const productionBuild = input.command === 'build' && input.mode === 'production';
  const localOnly = !url && !key;

  if (productionBuild && localOnly && input.allowLocalOnly !== 'true') {
    throw new BuildEnvError(
      'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are not set, so this production build ' +
        'would have no sign-in or sync. Set them in your hosting settings (Cloudflare: Settings → ' +
        'Variables and Secrets, for Production and Preview) or in .env.local. To build the ' +
        'local-only app on purpose, set ALLOW_LOCAL_ONLY_BUILD=true.',
    );
  }

  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BuildEnvError(`VITE_SUPABASE_URL is not a valid URL: ${url}`);
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (productionBuild && parsed.protocol !== 'https:' && !local) {
      throw new BuildEnvError(`VITE_SUPABASE_URL must use https (got ${url}).`);
    }
  }

  return { url, key, localOnly };
}
