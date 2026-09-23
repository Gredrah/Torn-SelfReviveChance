const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.torn.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DEFAULT_SINCE_SECONDS = 24 * 60 * 60;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function asOptionalInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReviveRecord(record) {
  const reviveId = asOptionalInt(record?.revive_id ?? record?.id ?? record?._reviveIdFromKey);
  const reviveTimestamp = asOptionalInt(record?.timestamp ?? record?.time);

  if (!Number.isFinite(reviveId) || reviveId <= 0) return null;
  if (!Number.isFinite(reviveTimestamp) || reviveTimestamp <= 0) return null;

  return {
    reviveId,
    reviveTimestamp,
    targetId: asOptionalInt(record?.target_id ?? record?.target?.id ?? record?.target),
    reviverId: asOptionalInt(record?.reviver_id ?? record?.reviver?.id ?? record?.reviver),
    chance: asOptionalNumber(record?.chance ?? record?.success_chance),
    result: typeof record?.result === "string" ? record.result : null,
    sourceUserId: asOptionalInt(record?.source_user_id),
    rawJson: JSON.stringify(record ?? {}),
  };
}

export default {
  async fetch(request, env) {
    console.log(`[revive-worker] ${request.method} ${new URL(request.url).pathname}`);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    const reviveEventsPathMatch = /^\/revive-events\/(target|reviver)\/(\d+)$/.exec(pathname);
    if (request.method === "GET" && reviveEventsPathMatch) {
      const role = reviveEventsPathMatch[1];
      const playerId = asOptionalInt(reviveEventsPathMatch[2]);

      if (!Number.isFinite(playerId) || playerId <= 0) {
        return jsonResponse({ error: "Invalid playerId" }, 400);
      }

      const sinceSecondsRaw = url.searchParams.get("since_seconds");
      const sinceSeconds = sinceSecondsRaw == null ? DEFAULT_SINCE_SECONDS : asOptionalInt(sinceSecondsRaw);
      if (!Number.isFinite(sinceSeconds) || sinceSeconds <= 0) {
        return jsonResponse({ error: "Invalid since_seconds" }, 400);
      }

      const limitRaw = url.searchParams.get("limit");
      let limit = limitRaw == null ? DEFAULT_LIMIT : asOptionalInt(limitRaw);
      if (!Number.isFinite(limit) || limit <= 0) {
        return jsonResponse({ error: "Invalid limit" }, 400);
      }
      limit = Math.min(limit, MAX_LIMIT);

      const serverTime = Math.floor(Date.now() / 1000);
      const sinceTimestamp = Math.max(0, serverTime - sinceSeconds);
      const columnName = role === "target" ? "target_id" : "reviver_id";

      const rows = await env.DB.prepare(
        `SELECT
          revive_id,
          revive_timestamp,
          target_id,
          reviver_id,
          chance,
          result,
          source_user_id,
          pulled_at
        FROM revive_events
        WHERE ${columnName} = ?
          AND revive_timestamp >= ?
        ORDER BY revive_timestamp DESC, revive_id DESC
        LIMIT ?`
      ).bind(playerId, sinceTimestamp, limit).all();

      const data = Array.isArray(rows?.results) ? rows.results : [];

      return jsonResponse({
        data,
        meta: {
          role,
          player_id: playerId,
          since_seconds: sinceSeconds,
          since_timestamp: sinceTimestamp,
          server_time: serverTime,
          count: data.length,
          limit,
        },
      });
    }

    if (request.method === "POST" && pathname === "/revivesfull") {
      try {
        const body = await request.json();
        const pulledAt = asOptionalInt(body?.pulled_at ?? body?.torn_timestamp);
        const sourceUserId = asOptionalInt(body?.source_user_id);
        const records = Array.isArray(body?.revives) ? body.revives : null;

        if (!Number.isFinite(pulledAt) || pulledAt <= 0) {
          return new Response("Invalid pulled_at value", { status: 400, headers: corsHeaders });
        }
        if (!records) {
          return new Response("Invalid revives payload", { status: 400, headers: corsHeaders });
        }

        const normalizedRecords = records
          .map((record) => normalizeReviveRecord({ ...record, source_user_id: record?.source_user_id ?? sourceUserId }))
          .filter(Boolean);

        console.log("[revive-worker] POST /revivesfull payload", {
          pulledAt,
          sourceUserId,
          receivedCount: records.length,
          validCount: normalizedRecords.length,
        });

        if (normalizedRecords.length === 0) {
          return jsonResponse({ success: true, inserted: 0, skipped: records.length });
        }

        const statement = `
          INSERT INTO revive_events (
            revive_id,
            revive_timestamp,
            target_id,
            reviver_id,
            chance,
            result,
            source_user_id,
            pulled_at,
            raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(revive_id) DO UPDATE SET
            revive_timestamp = excluded.revive_timestamp,
            target_id = excluded.target_id,
            reviver_id = excluded.reviver_id,
            chance = excluded.chance,
            result = excluded.result,
            source_user_id = excluded.source_user_id,
            pulled_at = excluded.pulled_at,
            raw_json = excluded.raw_json
        `;

        const batchedWrites = normalizedRecords.map((record) =>
          env.DB.prepare(statement).bind(
            record.reviveId,
            record.reviveTimestamp,
            record.targetId,
            record.reviverId,
            record.chance,
            record.result,
            record.sourceUserId,
            pulledAt,
            record.rawJson
          )
        );

        await env.DB.batch(batchedWrites);

        return jsonResponse({
          success: true,
          inserted: normalizedRecords.length,
          skipped: records.length - normalizedRecords.length,
        });
      } catch (err) {
        console.error("[revive-worker] Failed to parse /revivesfull payload:", err);
        return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }
    }

    const match = new RegExp(/^\/(\d+)$/).exec(pathname);

    if (!match) {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    const targetId = Number.parseInt(match[1], 10);

    if (request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT score_total, last_updated FROM revives WHERE target_id = ?"
      ).bind(targetId).first();

      console.log('[revive-worker] GET lookup', {
        targetId,
        found: !!result,
        result,
      });

      if (!result) {
        console.log('[revive-worker] GET miss', { targetId });
        return jsonResponse({ error: "No data found" }, 404);
      }

      console.log('[revive-worker] GET hit', {
        targetId,
        score_total: result.score_total,
        last_updated: result.last_updated,
      });

      return jsonResponse(result);
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        const { score_total, torn_timestamp } = body;

        if (typeof score_total !== 'number' || score_total < 0) {
           return new Response("Invalid score_total value", { status: 400, headers: corsHeaders });
        }
        if (typeof torn_timestamp !== 'number' || torn_timestamp <= 0) {
           return new Response("Invalid torn_timestamp value", { status: 400, headers: corsHeaders });
        }

        console.log('[revive-worker] POST payload', {
          targetId,
          score_total,
          torn_timestamp,
        });

        // UPSERT using Torn's exact time instead of Cloudflare's time
        await env.DB.prepare(`
          INSERT INTO revives (target_id, score_total, last_updated)
          VALUES (?, ?, ?)
          ON CONFLICT(target_id) DO UPDATE SET
            score_total = excluded.score_total,
            last_updated = excluded.last_updated
        `).bind(targetId, score_total, torn_timestamp).run();

        console.log('[revive-worker] POST upsert complete', {
          targetId,
          score_total,
          torn_timestamp,
        });

        return jsonResponse({ success: true, targetId, score_total, last_updated: torn_timestamp });
      } catch (err) {
        console.error("[revive-worker] Failed to parse revive update payload:", err);
        return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};
