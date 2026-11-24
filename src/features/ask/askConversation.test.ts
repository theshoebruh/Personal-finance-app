import type Anthropic from '@anthropic-ai/sdk';
import { ASK_MAX_ROUNDS } from '../../../supabase/functions/ask/tools';
import { type AskReply, askQuestion } from './askConversation';
import { AskToolError } from './askTools';

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.TextBlock;
const toolUse = (id: string, name: string, input: unknown) =>
  ({
    type: 'tool_use',
    id,
    name,
    input,
    caller: { type: 'direct' },
  }) as unknown as Anthropic.ToolUseBlock;

function fakeSend(replies: AskReply[]) {
  const sent: Anthropic.MessageParam[][] = [];
  const send = async (messages: Anthropic.MessageParam[]) => {
    sent.push(structuredClone(messages));
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    return next;
  };
  return { send, sent };
}

describe('askQuestion', () => {
  it('runs the tools Claude asks for and returns its answer', async () => {
    const { send, sent } = fakeSend([
      {
        content: [
          text('Let me check.'),
          toolUse('t1', 'spending_by_category', { start: 'a', end: 'b' }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [text('Most went to **Savings**.')], stop_reason: 'end_turn' },
    ]);
    const runTool = vi.fn(() => '{"categories":[]}');
    const r = await askQuestion({
      history: [],
      question: 'Where did it go?',
      context: 'Today is 2026-11-24.',
      send,
      runTool,
    });

    expect(r).toMatchObject({ answer: 'Most went to **Savings**.' });
    expect(r.problem).toBeUndefined();
    expect(runTool).toHaveBeenCalledWith('spending_by_category', { start: 'a', end: 'b' });
    // Second call carries Claude's tool request and the result.
    expect(sent[1]!.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"categories":[]}' }],
    });
    expect(r.history).toHaveLength(4);
    expect(r.history[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Today is 2026-11-24.' },
        { type: 'text', text: 'Where did it go?' },
      ],
    });
  });

  it('reports a tool error to Claude instead of failing', async () => {
    const { send, sent } = fakeSend([
      { content: [toolUse('t1', 'period_summary', {})], stop_reason: 'tool_use' },
      { content: [text('Sorry.')], stop_reason: 'end_turn' },
    ]);
    await askQuestion({
      history: [],
      question: 'q',
      context: 'c',
      send,
      runTool: () => {
        throw new AskToolError('start and end must be dates');
      },
    });
    expect(sent[1]!.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'start and end must be dates',
          is_error: true,
        },
      ],
    });
  });

  it('keeps the earlier conversation but drops a declined or runaway question', async () => {
    const earlier: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const declined = await askQuestion({
      history: earlier,
      question: 'q',
      context: 'c',
      ...fakeSend([{ content: [], stop_reason: 'refusal' }]),
      runTool: () => '',
    });
    expect(declined).toMatchObject({
      history: earlier,
      problem: expect.stringMatching(/declined/),
    });

    const loop = Array.from({ length: ASK_MAX_ROUNDS }, (_, i) => ({
      content: [toolUse(`t${i}`, 'period_summary', {})],
      stop_reason: 'tool_use' as const,
    }));
    const runaway = await askQuestion({
      history: earlier,
      question: 'q',
      context: 'c',
      ...fakeSend(loop),
      runTool: () => '{}',
    });
    expect(runaway).toMatchObject({
      history: earlier,
      problem: expect.stringMatching(/too many steps/),
    });
  });
});
