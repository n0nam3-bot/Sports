/**
 * A workspace id (`ownerId`) is the only credential protecting a person's
 * private data — their bet tracker, tuned prompts and run history. Rows from the
 * shared ledger are public, so the id must never be serialised into a response.
 */
export function scrub<T extends { ownerId?: unknown }>(row: T): Omit<T, "ownerId"> {
  const { ownerId: _omit, ...rest } = row;
  void _omit;
  return rest;
}
