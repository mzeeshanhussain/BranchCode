import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isAdminRole } from "@/lib/roles";
import { buildAgentGraph } from "@/lib/agent/graph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import agentCases from "@/tests/evals/agent-cases.json";
import guardrailCases from "@/tests/evals/guardrail-cases.json";
import qualityCases from "@/tests/evals/quality-cases.json";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALL_CASES = [
  ...agentCases.map((c) => ({ ...c, suite: "contract" })),
  ...guardrailCases.map((c) => ({ ...c, suite: "guardrail" })),
  ...qualityCases.map((c) => ({ ...c, suite: "quality" })),
];

const JUDGE_BASE_URL = process.env.JUDGE_BASE_URL; // e.g. http://192.168.1.123:11434/v1
const JUDGE_MODEL = process.env.JUDGE_MODEL || "qwen2.5:32b";
const EVAL_MODE = process.env.EVAL_MODE || "local"; // "local" = Qwen, "prod" = Gemini

// Qwen runners injected into the agent graph for evals.
// Only active when EVAL_MODE=local — "prod" lets Gemini run normally.
function makeQwenRunners() {
  if (EVAL_MODE !== "local" || !JUDGE_BASE_URL) return {};
  const model = new ChatOpenAI({
    model: JUDGE_MODEL,
    apiKey: "ollama",
    configuration: { baseURL: JUDGE_BASE_URL },
    temperature: 0,
  });
  return {
    runText: async ({ instructions, input }) => {
      const res = await model.invoke([new SystemMessage(instructions), new HumanMessage(input)]);
      return res.content ?? null;
    },
    runWithTools: async ({ instructions, messages, tools }) => {
      return model.bindTools(tools).invoke([new SystemMessage(instructions), ...messages]);
    },
  };
}

async function judgeResponse(question, response, rubric) {
  const prompt = `You are a strict evaluator for a chat agent called Dex. Score the response below.\n\nUSER MESSAGE: ${question}\n\nAGENT RESPONSE: ${response}\n\nRUBRIC: ${rubric}\n\nReply with a JSON object ONLY:\n{"pass": true or false, "reason": "one sentence"}`;

  // Use local LLM if JUDGE_BASE_URL is configured
  if (JUDGE_BASE_URL) {
    try {
      const res = await fetch(`${JUDGE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(60000), // local LLM is slower than Gemini
      });
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content || "";
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { pass: false, reason: `Judge returned no JSON: ${raw.slice(0, 100)}` };
      return JSON.parse(match[0]);
    } catch (err) {
      return { pass: null, reason: `Local judge error: ${err.message}` };
    }
  }

  // Fallback: Gemini
  const key = process.env.LLM_API_KEY;
  if (!key) return { pass: null, reason: "no LLM_API_KEY — judge skipped" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { pass: false, reason: `Judge returned no JSON: ${raw.slice(0, 100)}` };
    return JSON.parse(match[0]);
  } catch (err) {
    return { pass: null, reason: `Judge error: ${err.message}` };
  }
}

function computeBySuite(results) {
  const bySuite = {};
  for (const r of results) {
    if (!bySuite[r.suite]) bySuite[r.suite] = { pass: 0, fail: 0, total: 0 };
    bySuite[r.suite].total++;
    bySuite[r.suite][r.pass ? "pass" : "fail"]++;
  }
  return bySuite;
}

async function requireEvalAccess(request) {
  // Allow local CLI with EVAL_SECRET header (bypasses Supabase auth)
  const secret = request.headers.get("x-eval-secret");
  if (secret && process.env.EVAL_SECRET && secret === process.env.EVAL_SECRET) {
    return { user: { id: null }, supabase: getSupabaseAdminClient(), error: null };
  }

  const { user, error: authError } = await requireAuth(request);
  if (authError) return { user: null, supabase: null, error: authError };

  const supabase = getSupabaseAdminClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (!isAdminRole(profile?.role)) {
    return {
      user: null,
      supabase: null,
      error: NextResponse.json({ error: "Admin only." }, { status: 403 }),
    };
  }

  return { user, supabase, error: null };
}

export async function GET(request) {
  const { supabase, error } = await requireEvalAccess(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);

  // GET ?run=<id> — return full results for a specific run
  const runId = searchParams.get("run");
  if (runId) {
    const { data } = await supabase
      .from("agent_eval_runs")
      .select("*")
      .eq("id", runId)
      .single();
    return NextResponse.json({ run: data || null });
  }

  const limit = Math.min(Number(searchParams.get("limit") || 20), 100);
  const { data, error: dbError } = await supabase
    .from("agent_eval_runs")
    .select("id, ran_at, ran_by, passed, total, pct, by_suite")
    .order("ran_at", { ascending: false })
    .limit(limit);

  if (dbError) return NextResponse.json({ runs: [] });
  return NextResponse.json({ runs: data || [] });
}

export async function POST(request) {
  const { user, supabase, error } = await requireEvalAccess(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const suiteFilter = searchParams.get("suite");

  const suitesToRun = suiteFilter
    ? ["contract", "guardrail", "quality"].filter((s) => s === suiteFilter)
    : ["contract", "guardrail", "quality"];

  const qwenRunners = makeQwenRunners();
  const enc = new TextEncoder();

  // Stream NDJSON — headers sent immediately, one JSON line per case result.
  // This avoids UND_ERR_HEADERS_TIMEOUT on long Qwen runs.
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (obj) => ctrl.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

      const allResults = [];
      let runId = null;

      try {
        for (const suite of suitesToRun) {
          const cases = ALL_CASES.filter((c) => c.suite === suite);

          for (const c of cases) {
            const isBoundaryExpected = !!(c.expectedBoundary || c.expectedOffTopic);
            const start = Date.now();
            let caseResult;
            try {
              const graph = buildAgentGraph({ supabase, request, user, runners: qwenRunners });
              const graphResult = await Promise.race([
                graph.invoke({
                  workflow: c.workflow,
                  message: c.message,
                  conversation: Array.isArray(c.conversation) ? c.conversation.slice(-10) : [],
                  quota: null,
                  confirmed: false,
                  confirmationToken: null,
                  ticketAction: null,
                  supportConfirmationToken: null,
                  priorEvidence: [],
                  sessionId: null,
                }),
                new Promise((_, rej) => setTimeout(() => rej(new Error("The operation was aborted due to timeout")), 90000)),
              ]);
              const data = graphResult.response
                ? { ...graphResult.response, _trace: { intent: graphResult.intent?.intent ?? null } }
                : { type: "error", message: "No response from agent", _trace: { intent: null } };

              const responseText = String(data.message || "");
              const responseLC = responseText.toLowerCase();
              const gotBoundary = data.type === "boundary";
              const boundaryPass = isBoundaryExpected ? gotBoundary : !gotBoundary;
              const typePass = c.expectedType ? data.type === c.expectedType : true;
              const gotIntent = data._trace?.intent ?? null;
              const intentPass = c.expectedIntent && gotIntent ? gotIntent === c.expectedIntent : true;
              const containsMissing = (c.responseContains || []).filter((s) => !responseLC.includes(s.toLowerCase()));
              const containsForbidden = (c.responseNotContains || []).filter((s) => responseLC.includes(s.toLowerCase()));

              const failures = [];
              if (!boundaryPass) failures.push(`expected boundary=${isBoundaryExpected}, got type=${data.type}`);
              if (!typePass) failures.push(`expected type=${c.expectedType}, got ${data.type}`);
              if (!intentPass) failures.push(`expected intent=${c.expectedIntent}, got ${gotIntent}`);
              for (const s of containsMissing) failures.push(`response missing: "${s}"`);
              for (const s of containsForbidden) failures.push(`response must NOT contain: "${s}"`);

              let judgeResult = null;
              if (c.judge && c.suite === "quality") {
                judgeResult = await judgeResponse(c.message, responseText, c.judge);
                if (judgeResult.pass === false) failures.push(`judge: ${judgeResult.reason}`);
              }

              const structuralPass =
                boundaryPass && typePass && intentPass &&
                containsMissing.length === 0 && containsForbidden.length === 0;
              const pass = structuralPass && (judgeResult === null || judgeResult.pass !== false);

              caseResult = {
                name: c.name, suite: c.suite, pass, failures,
                got: data.type, gotIntent, judge: judgeResult,
                message: responseText.slice(0, 160) || null, ms: Date.now() - start,
              };
            } catch (err) {
              caseResult = {
                name: c.name, suite: c.suite, pass: false,
                failures: [`error: ${err.message}`],
                got: "error", gotIntent: null, judge: null,
                message: err.message, ms: Date.now() - start,
              };
            }

            allResults.push(caseResult);
            send({ type: "case", ...caseResult });
          }

          // Save partial results after each suite
          const passed = allResults.filter((r) => r.pass).length;
          const bySuite = computeBySuite(allResults);
          try {
            if (runId) {
              await supabase.from("agent_eval_runs")
                .update({ passed, total: allResults.length, by_suite: bySuite, results: allResults })
                .eq("id", runId);
            } else {
              const { data: runRecord } = await supabase.from("agent_eval_runs")
                .insert({ ran_by: user.id, passed, total: allResults.length, by_suite: bySuite, results: allResults })
                .select("id").single();
              runId = runRecord?.id;
            }
          } catch { /* best-effort */ }
        }

        const passed = allResults.filter((r) => r.pass).length;
        send({ type: "done", passed, total: allResults.length, bySuite: computeBySuite(allResults), runId });
      } catch (err) {
        send({ type: "error", message: err.message });
      }

      ctrl.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
  });
}
