/**
 * "Ask" — answers questions about the signed-in user's budget with Claude.
 *
 * The app sends the conversation; this function adds the fixed instructions and tool list, calls
 * Claude once and returns its reply. When Claude asks for a tool, the app runs it on the phone
 * against local data and sends the result back in the next call, so this function never reads the
 * user's data and holds nothing but the API key.
 *
 * Secrets (supabase secrets set …): ANTHROPIC_API_KEY, ASK_ALLOWED_USER_IDS (comma-separated user
 * ids allowed to use it; nobody when unset). Optional: ASK_ALLOWED_ORIGINS (comma-separated).
 */
import Anthropic from 'npm:@anthropic-ai/sdk@1.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.109.0';
import { ASK_MAX_ROUNDS, ASK_MODEL, ASK_SYSTEM, ASK_TOOLS } from './tools.ts';

const DEFAULT_ORIGINS = ['https://personal-finance-app-6tt.pages.dev', 'http://localhost:5173'];
const MAX_BODY_CHARS = 200_000;
const MAX_MESSAGES = 4 * ASK_MAX_ROUNDS + 20;

const list = (name: string) =>
  (Deno.env.get(name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = list('ASK_ALLOWED_ORIGINS');
  const origins = allowed.length > 0 ? allowed : DEFAULT_ORIGINS;
  const ok =
    origin &&
    (origins.includes(origin) ||
      /^https:\/\/[a-z0-9-]+\.personal-finance-app-6tt\.pages\.dev$/.test(origin));
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function reply(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** Light shape check: the API validates the details. */
function validMessages(value: unknown): value is Anthropic.MessageParam[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) return false;
  if ((value[0] as { role?: unknown })?.role !== 'user') return false;
  let assistantTurns = 0;
  for (const m of value) {
    if (!m || typeof m !== 'object') return false;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== 'user' && role !== 'assistant') return false;
    if (typeof content !== 'string' && !Array.isArray(content)) return false;
    if (role === 'assistant') assistantTurns++;
  }
  // Each question gets at most ASK_MAX_ROUNDS calls; a conversation holds a few questions.
  return assistantTurns <= ASK_MAX_ROUNDS * 5;
}

let client: Anthropic | null = null;

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, cors);

  // Who is asking (the platform has already checked the token is valid).
  const authorization = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return reply(401, { error: 'not_signed_in' }, cors);
  if (!list('ASK_ALLOWED_USER_IDS').includes(auth.user.id)) {
    return reply(403, { error: 'not_allowed' }, cors);
  }

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return reply(413, { error: 'too_long' }, cors);
  let body: { probe?: unknown; messages?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: 'bad_request' }, cors);
  }
  // The app checks whether Ask is available to this account before showing the chat.
  if (body.probe === true) return reply(200, { allowed: true }, cors);
  if (!validMessages(body.messages)) return reply(400, { error: 'bad_request' }, cors);

  try {
    if (!Deno.env.get('ANTHROPIC_API_KEY')) return reply(503, { error: 'not_configured' }, cors);
    client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
    const response = await client.messages.create({
      model: ASK_MODEL,
      max_tokens: 4096,
      system: ASK_SYSTEM,
      tools: ASK_TOOLS as unknown as Anthropic.Tool[],
      messages: body.messages,
      cache_control: { type: 'ephemeral' },
    });
    return reply(
      200,
      { content: response.content, stop_reason: response.stop_reason, usage: response.usage },
      cors,
    );
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return reply(429, { error: 'busy' }, cors);
    if (error instanceof Anthropic.BadRequestError) {
      console.error('Claude rejected the request:', error.message);
      return reply(400, { error: 'bad_request' }, cors);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('ANTHROPIC_API_KEY is missing or invalid');
      return reply(503, { error: 'not_configured' }, cors);
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
      return reply(502, { error: 'upstream' }, cors);
    }
    console.error('Ask failed:', error);
    return reply(502, { error: 'upstream' }, cors);
  }
});
