import { describe, expect, it, vi } from 'vitest';
import { readFallbackPages, FALLBACK_PAGE_SIZE } from './fallbackPaging';

const row = (id: number, created_at: string) => ({ id: String(id), created_at });
const older = '2026-11-18T00:00:00.000Z';
const newer = '2026-11-18T00:00:01.000Z';

describe('HTTP fallback pagination', () => {
  it('drains more than 100 records without dropping the second page', async () => {
    const all = Array.from({ length: 237 }, (_, id) => row(id, id < 180 ? older : newer));
    const seen: string[] = [];
    const load = vi.fn(async (from: number, to: number) => ({ data: all.slice(from, to + 1), error: null }));
    const cursor = await readFallbackPages('2026-11-17T23:59:59.000Z', load, items => seen.push(...items.map(i => i.id)));
    expect(seen).toHaveLength(237);
    expect(new Set(seen).size).toBe(237);
    expect(cursor).toBe(newer);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenNthCalledWith(2, FALLBACK_PAGE_SIZE, 2 * FALLBACK_PAGE_SIZE - 1, '2026-11-17T23:59:59.000Z');
  });

  it('keeps an inclusive timestamp for messages arriving with the same timestamp', async () => {
    const batches = [[row(1, older)], [row(1, older), row(2, older)]];
    const known = new Set<string>();
    let since = '2026-11-17T23:59:59.000Z';
    for (const batch of batches) {
      since = await readFallbackPages(since, async () => ({ data: batch, error: null }), items => {
        for (const item of items) known.add(item.id);
      });
    }
    expect([...known]).toEqual(['1', '2']);
    expect(since).toBe(older);
  });

  it('does not advance the cursor after a failed later page', async () => {
    let pages = 0;
    const load = vi.fn(async () => {
      pages++;
      return pages === 1
        ? { data: Array.from({ length: FALLBACK_PAGE_SIZE }, (_, i) => row(i, older)), error: null }
        : { data: null, error: { message: 'network failure' } };
    });
    await expect(readFallbackPages('2026-11-17T23:59:59.000Z', load, () => {})).rejects.toThrow('network failure');
  });
});
