import type Anthropic from '@anthropic-ai/sdk';
import { ASK_MAX_ROUNDS } from '../../../supabase/functions/ask/tools';
import { AskToolError } from './askTools';

/** What the Supabase "ask" function returns for one Claude call. */
export interface AskReply {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason | null;
}

export type AskSend = (messages: Anthropic.MessageParam[]) => Promise<AskReply>;
export type AskRunTool = (name: string, input: unknown) => string;

export interface AskResult {
  /** The conversation so far, to send with the next question (Claude's replies kept unchanged). */
  history: Anthropic.MessageParam[];
  answer: string;
  /** Set when there's no proper answer (declined, cut off, too many steps). */
  problem?: string;
}

const textOf = (content: readonly Anthropic.ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Asks one question: sends it with the earlier conversation, runs any tools Claude asks for on
 * local data, and repeats until Claude answers (at most ASK_MAX_ROUNDS calls).
 */
export async function askQuestion(opts: {
  history: readonly Anthropic.MessageParam[];
  question: string;
  /** Today's date and the periods, so "this month" means something. */
  context: string;
  send: AskSend;
  runTool: AskRunTool;
}): Promise<AskResult> {
  const messages: Anthropic.MessageParam[] = [
    ...opts.history,
    {
      role: 'user',
      content: [
        { type: 'text', text: opts.context },
        { type: 'text', text: opts.question },
      ],
    },
  ];
  for (let round = 0; round < ASK_MAX_ROUNDS; round++) {
    const reply = await opts.send(messages);
    // Keep Claude's reply exactly as returned (thinking blocks included) for the next call.
    messages.push({ role: 'assistant', content: reply.content });

    if (reply.stop_reason === 'refusal') {
      // Drop the declined question so the conversation can carry on.
      return {
        history: [...opts.history],
        answer: '',
        problem: 'Claude declined to answer that one.',
      };
    }
    if (reply.stop_reason === 'tool_use') {
      const results: Anthropic.ToolResultBlockParam[] = reply.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => {
          try {
            return {
              type: 'tool_result',
              tool_use_id: b.id,
              content: opts.runTool(b.name, b.input),
            };
          } catch (e) {
            const message = e instanceof AskToolError ? e.message : 'The tool failed.';
            return { type: 'tool_result', tool_use_id: b.id, content: message, is_error: true };
          }
        });
      messages.push({ role: 'user', content: results });
      continue;
    }
    const answer = textOf(reply.content);
    if (reply.stop_reason === 'max_tokens') {
      // Not kept: a reply cut off mid tool call can't be continued.
      return { history: [...opts.history], answer, problem: 'The answer was cut short.' };
    }
    return { history: messages, answer };
  }
  return {
    history: [...opts.history],
    answer: '',
    problem: 'That took too many steps. Try asking something more specific.',
  };
}
