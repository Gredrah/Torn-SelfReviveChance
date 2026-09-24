import { describe, expect, it, vi, beforeEach } from 'vitest';
import worker from '../src/index.js';

const fixedNow = 1_700_000_000;

function createDbMock({
  firstResult = null,
  allResult = [],
  runResult = { success: true },
  batchResult = undefined,
} = {}) {
  const state = {
    boundValues: [],
    preparedSql: [],
    firstCalls: 0,
    allCalls: 0,
    runCalls: 0,
    batchCalls: 0,
  };

  const prepare = vi.fn((sql) => {
    state.preparedSql.push(sql);
    return {
      bind: (...values) => {
        state.boundValues.push(values);
        return {
          first: vi.fn(async () => {
            state.firstCalls += 1;
            return firstResult;
          }),
          all: vi.fn(async () => {
            state.allCalls += 1;
            return { results: allResult };
          }),
          run: vi.fn(async () => {
            state.runCalls += 1;
            return runResult;
          }),
        };
      },
    };
  });

  const batch = vi.fn(async (operations) => {
    state.batchCalls += 1;
    state.batchedOperations = operations;
    return batchResult;
  });

  return {
    env: {
      DB: {
        prepare,
        batch,
      },
    },
    state,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(fixedNow * 1000);
});

describe('Cloudflare worker harness', () => {
  it('responds to CORS preflight', async () => {
    const { env } = createDbMock();
    const response = await worker.fetch(new Request('https://example.com/revive-events/target/123', { method: 'OPTIONS' }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.torn.com');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('returns revive events with the requested filters applied', async () => {
    const rows = [{ revive_id: 1, revive_timestamp: fixedNow - 30, target_id: 123, reviver_id: 555, chance: 92, result: 'success', source_user_id: 77, pulled_at: fixedNow }];
    const { env, state } = createDbMock({ allResult: rows });

    const response = await worker.fetch(new Request('https://example.com/revive-events/target/123?since_seconds=1800&limit=25'), env);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.meta.role).toBe('target');
    expect(payload.meta.player_id).toBe(123);
    expect(payload.meta.since_seconds).toBe(1800);
    expect(payload.meta.limit).toBe(25);
    expect(payload.data).toEqual(rows);
    expect(state.boundValues.at(-1)).toEqual([123, fixedNow - 1800, 25]);
  });

  it('rejects invalid revive-events query parameters', async () => {
    const { env } = createDbMock();
    const response = await worker.fetch(new Request('https://example.com/revive-events/target/123?since_seconds=0'), env);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('Invalid since_seconds');
  });

  it('rejects invalid revive-events player ids and limits', async () => {
    const { env } = createDbMock();
    const invalidPlayerResponse = await worker.fetch(new Request('https://example.com/revive-events/target/abc'), env);
    const invalidLimitResponse = await worker.fetch(new Request('https://example.com/revive-events/target/123?limit=0'), env);

    expect(invalidPlayerResponse.status).toBe(404);
    expect(invalidLimitResponse.status).toBe(400);
  });

  it('normalizes revivesfull payloads and skips invalid rows', async () => {
    const { env, state } = createDbMock();
    const body = {
      pulled_at: fixedNow,
      source_user_id: 91,
      revives: [
        { revive_id: 101, timestamp: fixedNow - 60, target_id: 123, reviver_id: 555, chance: 95.5, result: 'success' },
        { revive_id: 0, timestamp: fixedNow - 60, target_id: 123 },
        { revive_id: 102, timestamp: fixedNow - 90, target_id: 456, reviver: { id: 777 }, success_chance: 88.1 },
      ],
    };

    const response = await worker.fetch(new Request('https://example.com/revivesfull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.inserted).toBe(2);
    expect(payload.skipped).toBe(1);
    expect(state.batchCalls).toBe(1);
    expect(state.batchedOperations).toHaveLength(2);
  });

  it('returns a no-op response for an empty revives payload', async () => {
    const { env, state } = createDbMock();
    const response = await worker.fetch(new Request('https://example.com/revivesfull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pulled_at: fixedNow, revives: [] }),
    }), env);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.inserted).toBe(0);
    expect(payload.skipped).toBe(0);
    expect(state.batchCalls).toBe(0);
  });

  it('returns legacy data when present and 404 when missing', async () => {
    const { env } = createDbMock({ firstResult: { score_total: 14, last_updated: fixedNow - 4000 } });
    const hitResponse = await worker.fetch(new Request('https://example.com/123'), env);
    const hitPayload = await hitResponse.json();

    expect(hitResponse.status).toBe(200);
    expect(hitPayload.score_total).toBe(14);

    const missEnv = createDbMock({ firstResult: null }).env;
    const missResponse = await worker.fetch(new Request('https://example.com/456'), missEnv);
    const missPayload = await missResponse.json();

    expect(missResponse.status).toBe(404);
    expect(missPayload.error).toBe('No data found');
  });
});
