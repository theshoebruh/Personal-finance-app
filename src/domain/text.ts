/**
 * A transaction description without card numbers, long digit runs or the "(Pending)" marker, so
 * it reads as a payee name and identifies no card or account.
 */
export function cleanDescription(description: string): string {
  return description
    .replace(/^\(pending\)\s*/i, '')
    .replace(/\(card\s*\d+\)/gi, '')
    .replace(/\d{4,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A payee name from a bank description: also drops prefixes like "Recurring Card Purchase:". */
export function payeeName(description: string): string {
  return cleanDescription(description)
    .replace(/^(recurring\s+)?(card\s+purchase|debit\s+order|card\s+payment|payment)\s*:\s*/i, '')
    .replace(/\s*…\s*$/, '')
    .trim();
}
