#!/usr/bin/env node
/**
 * One-time backfill: score old agent_chat_sessions that have no session_summary.
 * Uses Qwen via JUDGE_BASE_URL — never hits Gemini.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-scores.js
 *
 * Required in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *   JUDGE_BASE_URL=http://192.168.1.123:11434/v1
 *   JUDGE_MODEL=qwen2.5:32b
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JUDGE_BASE_URL = process.env.JUDGE_BASE_URL;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "qwen2.5:32b";

// --- validation ---
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("\nERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.\n");
  process.exit(1);
}
if (!JUDGE_BASE_URL) {
  console.error("\nERROR: JUDGE_BASE_URL is required (e.g. http://192.168.1.123:11434/v1).");
  console.error("Set it in .env.local — this script must NOT hit Gemini.\n");
  process.exit(1);
}

const BATCH_SIZE = 20; // fetch N sessions at a time
const TIMEOUT_MS = 120_000; // 2 min per session (Qwen 32B is slow)

// --- Supabase helpers (raw REST, no SDK) ---
function sbHeaders() {
  return {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
  };
}

async function fetchUnscoredSessions(offset) {
  const url =
    `${SUPABASE_URL}/rest/v1/agent_chat_sessions` +
    `?session_summary=is.null` +
    `&messages=not.is.null` +
    `&select=id,messages` +
    `&order=started_at.desc` +
    `&limit=${BATCH_SIZE}&offset=${offset}`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateSession(id, fields) {
  const url = `${SUPABASE_URL}/rest/v1/agent_chat_sessions?id=eq.${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: sbHeaders(),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Supabase update failed: ${res.status} ${await res.text()}`);
}

// --- Qwen scoring (same prompt as scoreSession in lib/agent/session.js) ---
async function scoreWithQwen(session) {
  const transcript = session.messages
    .map((m) => `${m.role === "user" ? "User" : "Dex"}: ${m.text || m.content || ""}`)
    .join("\n");

  const prompt = `You are a quality reviewer for Dex, an AI assistant for a developer diagnostics SaaS called Speedy.

Review the following conversation transcript and return ONLY a JSON object with these fields:
{
  "sentiment": "positive" | "neutral" | "negative" | "frustrated",
  "correct_tool": true | false | null,
  "offered_support": true | false,
  "failure_turn": integer or null,
  "notes": "one sentence quality observation",
  "session_summary": "2-3 sentence narrative of what happened in this chat and whether the user got what they needed",
  "session_suggestion": "1-2 sentence action item for the engineering team — what to fix, what to add to evals, or what edge case to cover"
}

Rules:
- sentiment: the user's overall tone at the end of the session
- correct_tool: whether Dex used or recommended the right Speedy tool for the request. null if no tool was applicable
- offered_support: true if Dex offered to create a support ticket when it couldn't fully help (this is a failure indicator)
- failure_turn: 1-based turn number where Dex gave a wrong/unhelpful response, or null if none
- notes: brief quality observation
- session_summary: plain narrative, 2-3 sentences, describe what the user asked and whether Dex handled it well
- session_suggestion: specific, actionable — name the scenario and what the team should do or add to evals

Transcript:
${transcript}`;

  const res = await fetch(`${JUDGE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Qwen API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Qwen returned no JSON: ${raw.slice(0, 120)}`);
  return JSON.parse(match[0]);
}

// --- main ---
async function main() {
  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const dim = "\x1b[2m";

  console.log(`\nBackfill session scores → Qwen (${JUDGE_MODEL})`);
  console.log(`Judge  → ${JUDGE_BASE_URL}`);
  console.log(`DB     → ${SUPABASE_URL}\n`);

  // Count total unscored first
  const countUrl =
    `${SUPABASE_URL}/rest/v1/agent_chat_sessions` +
    `?session_summary=is.null&messages=not.is.null` +
    `&select=id`;
  const countRes = await fetch(countUrl, {
    headers: { ...sbHeaders(), Prefer: "count=exact" },
  });
  const totalHeader = countRes.headers.get("content-range");
  const total = totalHeader ? parseInt(totalHeader.split("/")[1], 10) : "?";
  console.log(`Found ${total} unscored sessions.\n`);

  if (total === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  let offset = 0;
  let done = 0;
  let failed = 0;

  while (true) {
    const batch = await fetchUnscoredSessions(offset);
    if (!batch.length) break;

    for (const session of batch) {
      if (!session.messages?.length) {
        // No messages — mark as scored_at so it won't show up again but leave summary null
        try {
          await updateSession(session.id, { scored_at: new Date().toISOString(), score_notes: "no messages" });
        } catch { /* ignore */ }
        done++;
        continue;
      }

      const start = Date.now();
      try {
        const scored = await scoreWithQwen(session);
        await updateSession(session.id, {
          sentiment: scored.sentiment || null,
          correct_tool: scored.correct_tool ?? null,
          offered_support: scored.offered_support ?? null,
          failure_turn: scored.failure_turn || null,
          score_notes: scored.notes || null,
          session_summary: scored.session_summary || null,
          session_suggestion: scored.session_suggestion || null,
          scored_at: new Date().toISOString(),
        });
        done++;
        const ms = Date.now() - start;
        process.stdout.write(
          `  ${green}✓${reset} ${session.id.slice(0, 8)}… ${dim}${scored.sentiment || "?"}${reset} (${ms}ms)\n`
        );
      } catch (err) {
        failed++;
        const ms = Date.now() - start;
        process.stdout.write(
          `  ${red}✗${reset} ${session.id.slice(0, 8)}… ${red}${err.message.slice(0, 80)}${reset} (${ms}ms)\n`
        );
      }
    }

    offset += batch.length;
    if (batch.length < BATCH_SIZE) break; // last page
  }

  const pct = done + failed ? Math.round((done / (done + failed)) * 100) : 100;
  const color = pct === 100 ? green : pct >= 80 ? yellow : red;
  console.log(`\n${color}${pct}%${reset}  ${done} scored, ${failed} failed\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
