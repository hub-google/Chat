/**
 * Drain messages saved while WebRTC is unavailable.
 *
 * The cursor is inclusive to avoid skipping records with the same
 * created_at; callers de-duplicate message UUIDs. Page boundaries use
 * created_at + id ordering so a burst of >100 messages is not truncated.
 */
export interface FallbackRow {
  id: string;
  created_at: string;
}
export interface FallbackPage<T> {
  data: T[] | null;
  error: { message: string } | null;
}
export const FALLBACK_PAGE_SIZE = 100;
export const FALLBACK_MAX_PAGES = 25;

export async function readFallbackPages<T extends FallbackRow>(
  since: string,
  load: (from: number, to: number, cursor: string) => Promise<FallbackPage<T>>,
  receive: (rows: T[]) => void,
): Promise<string> {
  let newest = since;
  for (let page = 0; page < FALLBACK_MAX_PAGES; page++) {
    const from = page * FALLBACK_PAGE_SIZE;
    const { data, error } = await load(from, from + FALLBACK_PAGE_SIZE - 1, since);
    if (error) throw new Error(error.message);
    if (!data) throw new Error('HTTP fallback returned no message data');
    receive(data);
    for (const row of data) if (row.created_at > newest) newest = row.created_at;
    if (data.length < FALLBACK_PAGE_SIZE) return newest;
  }
  // With a saturated room, the next poll resumes at the inclusive last
  // timestamp and de-duplicates. The capped scan avoids unbounded requests.
  return newest;
}
