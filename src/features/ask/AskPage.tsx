import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type Anthropic from '@anthropic-ai/sdk';
import { useApp } from '@/app/AppContext';
import { FunctionCallError, useSync } from '@/app/SyncContext';
import { budgetPeriod, withReceivedPaydays } from '@/domain/calculations/period';
import { addDays } from '@/domain/dates';
import { Alert, Card, Loading } from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';
import { useBuckets } from '../home/useBuckets';
import { type AskReply, askQuestion } from './askConversation';
import { runAskTool } from './askTools';

const OPT_IN_KEY = 'askOptIn';

const SUGGESTIONS = [
  'Where did most of my money go this period?',
  'What were my biggest purchases this period?',
  'How does this period compare to the last one?',
  'How much have I spent on eating out lately?',
];

function readOptIn(): boolean {
  try {
    return localStorage.getItem(OPT_IN_KEY) === '1';
  } catch {
    return false;
  }
}
function writeOptIn(on: boolean) {
  try {
    if (on) localStorage.setItem(OPT_IN_KEY, '1');
    else localStorage.removeItem(OPT_IN_KEY);
  } catch {
    // Storage unavailable: the choice lasts until the page is closed.
  }
}

/** Claude's answer as text, with **bold** and line breaks kept. */
export function AnswerText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*)/g).forEach((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      parts.push(<strong key={i}>{part.slice(2, -2)}</strong>);
    else if (part) parts.push(part);
  });
  return <p className="ask-answer">{parts}</p>;
}

function errorText(e: unknown): string {
  if (e instanceof FunctionCallError) {
    if (e.status === 403) return 'Ask isn’t turned on for your account.';
    if (e.status === 429) return 'Claude is busy right now. Try again in a minute.';
    if (e.status === 503) return 'Ask isn’t set up on the server yet (no Claude API key).';
    if (e.status === 0) return 'Couldn’t reach the server. Check your connection and try again.';
  }
  return 'Something went wrong getting an answer. Try again.';
}

interface Entry {
  question: string;
  answer?: string;
  problem?: string;
}

type Access = 'checking' | 'allowed' | 'blocked';

export function AskPage() {
  const sync = useSync();
  const { today } = useApp();
  const buckets = useBuckets();
  const [optedIn, setOptedIn] = useState(readOptIn);
  const [access, setAccess] = useState<Access>('checking');
  const [accessError, setAccessError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<Anthropic.MessageParam[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sync || !optedIn) return;
    let live = true;
    setAccess('checking');
    sync
      .callFunction('ask', { probe: true })
      .then(() => live && setAccess('allowed'))
      .catch((e: unknown) => {
        if (!live) return;
        setAccess('blocked');
        setAccessError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [sync, optedIn]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [entries]);

  const header = (
    <PageHeader title="Ask" subtitle="Questions about your money, answered by Claude" />
  );

  if (!sync) {
    return (
      <>
        {header}
        <Card>
          <p>Ask works when you’re signed in, because questions go through your account.</p>
        </Card>
      </>
    );
  }

  if (!optedIn) {
    return (
      <>
        {header}
        <Card title="Before you turn it on">
          <div className="stack">
            <p>
              Ask uses <strong>Claude</strong>, Anthropic’s AI, to answer questions like “Where did
              most of my money go?”.
            </p>
            <p>
              Your statements stay on your phone. When you ask something, the app works out the
              figures it needs here and sends Claude only those: totals per group and category, and
              for questions about purchases, the merchant names, dates and amounts in the period you
              ask about. Card numbers are removed first.
            </p>
            <p className="small muted">
              Nothing is sent until you ask a question. You can turn Ask off again at the bottom of
              this page.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  writeOptIn(true);
                  setOptedIn(true);
                }}
              >
                Turn on Ask
              </button>
            </div>
          </div>
        </Card>
      </>
    );
  }

  if (!buckets || access === 'checking') {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }

  const turnOff = (
    <p className="small muted ask-footer">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          writeOptIn(false);
          setOptedIn(false);
          setEntries([]);
          setHistory([]);
        }}
      >
        Turn off Ask
      </button>
    </p>
  );

  if (access === 'blocked') {
    return (
      <>
        {header}
        <Alert tone="info">{accessError}</Alert>
        {turnOff}
      </>
    );
  }

  const { data, period } = buckets;
  const pay = withReceivedPaydays(today, data.settings, data.recurringRules, data.transactions);
  const previous = budgetPeriod(addDays(period.start, -1), pay);
  const periodWord = period.mode === 'pay_period' ? 'pay period' : 'month';
  const context =
    `Today is ${today}. Current ${periodWord}: ${period.start} to ${period.end}` +
    (period.awaitingSalarySince ? ' (still waiting for this month’s salary)' : '') +
    `. Previous ${periodWord}: ${previous.start} to ${previous.end}.`;

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy || !sync || !buckets) return;
    setBusy(true);
    setQuestion('');
    setEntries((e) => [...e, { question: q }]);
    const settle = (patch: Partial<Entry>) =>
      setEntries((e) => e.map((x, i) => (i === e.length - 1 ? { ...x, ...patch } : x)));
    try {
      const result = await askQuestion({
        history,
        question: q,
        context,
        send: (messages) => sync.callFunction('ask', { messages }) as Promise<AskReply>,
        runTool: (name, input) => runAskTool(name, input, data, today),
      });
      setHistory(result.history);
      settle({ answer: result.answer, ...(result.problem ? { problem: result.problem } : {}) });
    } catch (e) {
      settle({ problem: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {header}
      {entries.length === 0 && (
        <Card title="Try asking">
          <div className="ask-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="btn btn-sm" onClick={() => void ask(s)}>
                {s}
              </button>
            ))}
          </div>
        </Card>
      )}
      {entries.length > 0 && (
        <div className="ask-thread" aria-live="polite">
          {entries.map((e, i) => (
            <div key={i} className="ask-turn">
              <p className="ask-question">{e.question}</p>
              {e.answer ? (
                <AnswerText text={e.answer} />
              ) : !e.problem ? (
                <p className="ask-answer muted" role="status">
                  Thinking…
                </p>
              ) : null}
              {e.problem && <p className="small negative">{e.problem}</p>}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
      <form
        className="ask-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label className="visually-hidden" htmlFor="ask-input">
          Your question
        </label>
        <input
          id="ask-input"
          value={question}
          placeholder="Ask about your spending…"
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !question.trim()}>
          Ask
        </button>
      </form>
      <p className="xs faint">
        Answers come from Claude and can be wrong; the figures on Home are the source of truth.
        {entries.length > 0 && (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => {
                setEntries([]);
                setHistory([]);
              }}
            >
              Start over
            </button>
          </>
        )}
      </p>
      {turnOff}
    </>
  );
}
