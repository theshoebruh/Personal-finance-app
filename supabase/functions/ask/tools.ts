/**
 * The "Ask" assistant's instructions and tools. Shared by the Supabase function (which sends them to
 * Claude) and the app (which runs the tools on the phone against local data), so it imports nothing.
 *
 * Claude never receives the data itself, only what these tools return for the question asked.
 */

export const ASK_MODEL = 'claude-haiku-5-5';

export const ASK_SYSTEM = `You answer questions about the user's personal budget in a South African budgeting app (amounts in rand, ZAR).

How the app works:
- Transactions are sorted into categories, and categories into groups (by default Needs, Wants, Savings and RF; Buffer is what's left of income after all spending).
- Budgets run per pay period (payday to payday) or per calendar month; the context message gives today's date and the current and previous periods.
- Pending card purchases count as spending. Moving money into a savings account counts in the Savings group.

How to answer:
- Use the tools to get figures; never guess or make up numbers, merchants or dates. If the tools don't cover something, say so.
- Unless the user names another time span, use the current period.
- Be brief: lead with the answer in a sentence or two, then at most a short list of the figures that matter. Format amounts like R1 234,56.
- You can explain the figures and point out patterns, but don't give personalised investment or financial-product advice.`;

const period = {
  start: { type: 'string', description: 'First day, YYYY-MM-DD' },
  end: { type: 'string', description: 'Last day, YYYY-MM-DD (inclusive)' },
} as const;

/** Tool definitions in the Messages API format (`Anthropic.Tool`). */
export const ASK_TOOLS = [
  {
    name: 'period_summary',
    description:
      'Income, total spending, what is left, and each group with its spending, goal and status, for a date range.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { ...period },
      required: ['start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'spending_by_category',
    description:
      'Spending per category (net of refunds) for a date range, largest first, with each category’s group and number of transactions.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { ...period },
      required: ['start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'top_payees',
    description:
      'Who the money went to: spending grouped by merchant or payee (from the transaction description), largest first.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ...period,
        limit: { type: 'integer', description: 'How many payees to return (1–25)' },
      },
      required: ['start', 'end', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_transactions',
    description:
      'Individual transactions in a date range, optionally only those whose description or category contains some text, largest amounts first.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ...period,
        contains: {
          type: 'string',
          description:
            'Only transactions whose description or category contains this text; "" for all',
        },
        kind: {
          type: 'string',
          enum: ['spending', 'income', 'all'],
          description: 'Which transactions to include',
        },
        limit: { type: 'integer', description: 'How many to return (1–50)' },
      },
      required: ['start', 'end', 'contains', 'kind', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'monthly_totals',
    description: 'Income and spending for each of the last few calendar months, oldest first.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'How many months, including this one (1–12)' },
      },
      required: ['months'],
      additionalProperties: false,
    },
  },
] as const;

export type AskToolName = (typeof ASK_TOOLS)[number]['name'];
export const ASK_TOOL_NAMES = ASK_TOOLS.map((t) => t.name) as AskToolName[];

/** Most Claude calls one question may take (each tool round is one). */
export const ASK_MAX_ROUNDS = 6;
