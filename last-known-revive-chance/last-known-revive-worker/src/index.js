// Define CORS headers to allow requests from Torn
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.torn.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    // 1. Handle CORS Preflight Requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // 2. Simple Routing: match URLs like /revive/1234567
    const match = new RegExp(/^\/(\d+)$/).exec(pathname);

    if (!match) {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    const targetId = Number.parseInt(match[1], 10);

    // 3. GET Method: Retrieve a target's revive chance
    if (request.method === "GET") {
      // Fetch from D1
      const result = await env.DB.prepare(
        "SELECT chance, last_updated FROM revives WHERE target_id = ?"
      ).bind(targetId).first();

      if (!result) {
        return new Response(JSON.stringify({ error: "No data found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 4. POST Method: Update a target's revive chance
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const { chance } = body;

        // Basic validation
        if (typeof chance !== 'number' || chance < 0 || chance > 100) {
           return new Response("Invalid chance value", { status: 400, headers: corsHeaders });
        }

        const now = Math.floor(Date.now() / 1000); // Unix timestamp

        // UPSERT: Insert new row, or update existing row if target_id already exists
        await env.DB.prepare(`
          INSERT INTO revives (target_id, chance, last_updated)
          VALUES (?, ?, ?)
          ON CONFLICT(target_id) DO UPDATE SET
            chance = excluded.chance,
            last_updated = excluded.last_updated
        `).bind(targetId, chance, now).run();

        return new Response(JSON.stringify({ success: true, targetId, chance, last_updated: now }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        // Invalid JSON or malformed request body is treated as a bad request.
        console.error("Failed to parse revive update payload:", err);
        return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }
    }

    // Fallback for unsupported methods
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};
