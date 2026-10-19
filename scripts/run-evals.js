#!/usr/bin/env node
/**
 * Run agent evals locally against the dev server.
 *
 * Usage:
 *   node --env-file=.env.local scripts/run-evals.js [suite]
 *
 * Required in .env.local:
 *   EVAL_SECRET=any-random-string          (same value in both .env.local files)
 *
 * Optional:
 *   EVAL_BASE_URL=http://localhost:3000    (default)
 *   JUDGE_BASE_URL=http://192.168.1.123:11434/v1
 *   JUDGE_MODEL=qwen2.5:32b
 */

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const EVAL_SECRET = process.env.EVAL_SECRET;

if (!EVAL_SECRET) {
  console.error("\nERROR: EVAL_SECRET not set.");
  console.error("Add to .env.local:\n  EVAL_SECRET=pick-any-random-string\n");
  process.exit(1);
}

const suiteArg = process.argv[2]; // optional: contract | guardrail | quality

async function main() {
  console.log(`\nRunning evals → ${BASE_URL}`);
  if (process.env.JUDGE_BASE_URL) {
    console.log(`Judge  → ${process.env.JUDGE_BASE_URL} (${process.env.JUDGE_MODEL || "qwen2.5:32b"})`);
  } else {
    console.log("Judge  → Gemini (set JUDGE_BASE_URL to use local LLM)");
  }
  if (suiteArg) console.log(`Suite  → ${suiteArg} only`);
  console.log("");

  const url = suiteArg
    ? `${BASE_URL}/api/admin/agent-evals?suite=${suiteArg}`
    : `${BASE_URL}/api/admin/agent-evals`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eval-secret": EVAL_SECRET,
      },
    });
  } catch (e) {
    console.error(`\nCannot reach ${BASE_URL} — is npm run dev running?\n${e.message}\ncause: ${e.cause?.code} ${e.cause?.message || ''}`);
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`\nServer error (${res.status}): ${text.slice(0, 300)}`);
    process.exit(1);
  }

  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";

  const results = [];
  let summary = null;

  // Read NDJSON stream — one JSON line per case, final "done" line at the end.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }

      if (event.type === "case") {
        results.push(event);
        const icon = event.pass ? `${green}✓${reset}` : `${red}✗${reset}`;
        const suiteLabel = `\x1b[33m${event.suite}\x1b[0m`;
        process.stdout.write(`  ${icon} [${suiteLabel}] ${event.name} (${event.ms}ms)\n`);
        if (!event.pass && event.failures?.length) {
          for (const f of event.failures) {
            process.stdout.write(`      ${f}\n`);
          }
        }
      } else if (event.type === "done") {
        summary = event;
      } else if (event.type === "error") {
        console.error(`\nServer error: ${event.message}`);
      }
    }
  }

  if (!summary) {
    summary = {
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      bySuite: {},
    };
  }

  const { passed, total, bySuite } = summary;
  const pct = total ? Math.round((passed / total) * 100) : 0;
  const passColor = pct === 100 ? green : pct >= 80 ? yellow : red;

  console.log(`\n${passColor}${pct}%${reset}  ${passed}/${total} passed\n`);

  for (const [suite, counts] of Object.entries(bySuite || {})) {
    const sp = counts.total ? Math.round((counts.pass / counts.total) * 100) : 0;
    const icon = sp === 100 ? `${green}✓${reset}` : sp >= 80 ? `${yellow}~${reset}` : `${red}✗${reset}`;
    console.log(`  ${icon}  ${suite.padEnd(12)} ${counts.pass}/${counts.total} (${sp}%)`);
  }

  console.log(`\nResults saved to Supabase.\n`);
  process.exit(pct === 100 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
