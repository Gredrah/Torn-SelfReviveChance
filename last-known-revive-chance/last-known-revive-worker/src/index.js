const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.torn.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    console.log(`[revive-worker] ${request.method} ${new URL(request.url).pathname}`);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const { pathname } = url;
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
        return new Response(JSON.stringify({ error: "No data found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      console.log('[revive-worker] GET hit', {
        targetId,
        score_total: result.score_total,
        last_updated: result.last_updated,
      });

      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
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

        return new Response(JSON.stringify({ success: true, targetId, score_total, last_updated: torn_timestamp }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        console.error("[revive-worker] Failed to parse revive update payload:", err);
        return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};
