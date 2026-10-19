import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { requireAuth } from "@/lib/require-auth";
import { getEffectivePlanId } from "@/lib/plan-features";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isAgentPlanAllowed } from "@/lib/agent/policy";
import { buildAgentGraph } from "@/lib/agent/graph";
import { saveSession } from "@/lib/agent/session";

export const dynamic = "force-dynamic";

async function fetchQuota(request) {
  try {
    const res = await fetch(new URL("/api/redirect-checks/quota", request.url), {
      headers: { authorization: request.headers.get("authorization") },
      cache: "no-store",
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export async function POST(request) {
  const supabase = getSupabaseAdminClient();
  const isEvalBypass =
    request.headers.get("x-speedy-eval") === "1" &&
    process.env.EVAL_SECRET &&
    request.headers.get("x-eval-secret") === process.env.EVAL_SECRET;

  let user;
  if (isEvalBypass) {
    user = { id: process.env.EVAL_USER_ID || null };
  } else {
    const { user: authUser, error: authError } = await requireAuth(request);
    if (authError) return authError;
    user = authUser;
    const planId = await getEffectivePlanId(user.id, supabase);
    if (!isAgentPlanAllowed(planId)) {
      return NextResponse.json(
        { type: "error", error: "Speedy Agent is available to internal users only." },
        { status: 403 }
      );
    }
  }

  const body = await request.json().catch(() => ({}));
  const {
    workflow,
    message,
    conversation,
    confirmed,
    confirmationToken,
    ticketAction,
    supportConfirmationToken,
    sessionId,
    priorEvidence,
  } = body;

  if (!message && !confirmed && !ticketAction) {
    return NextResponse.json(
      { type: "error", error: "Message is required." },
      { status: 400 }
    );
  }

  const quota = await fetchQuota(request);
  const graph = buildAgentGraph({ supabase, request, user });

  let result;
  try {
    result = await graph.invoke({
      workflow: workflow || "freeform",
      message: typeof message === "string" ? message.trim() : "",
      sessionId: sessionId || null,
      conversation: Array.isArray(conversation) ? conversation.slice(-10) : [],
      quota,
      confirmed: Boolean(confirmed),
      confirmationToken: confirmationToken || null,
      ticketAction: ticketAction || null,
      supportConfirmationToken: supportConfirmationToken || null,
      priorEvidence: Array.isArray(priorEvidence) ? priorEvidence : [],
    });
  } catch (err) {
    console.error("Agent graph error:", err.message);
    return NextResponse.json(
      { type: "error", message: "The agent encountered an error. Please try again." },
      { status: 500 }
    );
  }

  if (!result.response) {
    return NextResponse.json(
      { type: "error", message: "The agent did not produce a response. Please try again." },
      { status: 500 }
    );
  }

  // Save session server-side after every completed turn (skip for eval runs).
  if (!isEvalBypass) try {
    const priorMessages = (Array.isArray(conversation) ? conversation : []).map((m) => ({
      role: m.role,
      text: m.content || m.text || "",
    }));
    const userTurn = message ? [{ role: "user", text: String(message).trim() }] : [];
    const assistantTurn = [{ role: "assistant", text: result.response.message || "" }];
    const allMessages = [...priorMessages, ...userTurn, ...assistantTurn];

    await saveSession(supabase, {
      id: sessionId || crypto.randomUUID(),
      userId: user.id,
      workflow: workflow || "freeform",
      messages: allMessages,
      boundaryHit: result.response.type === "boundary",
      ticketOffered: result.response.type === "ticket_offer" || result.response.type === "ticket_created",
      ticketCreated: result.response.type === "ticket_created",
      ticketId: result.response.ticketId || null,
    });
  } catch (err) {
    console.error("[session] save failed:", err.message);
  }

  // Attach a safe trace to responses when the eval header is present.
  // Only exposes intent label — no secrets, no internal state.
  const isEvalRun = request.headers.get("x-speedy-eval") === "1";
  const responseBody = isEvalRun && result.intent
    ? { ...result.response, _trace: { intent: result.intent?.intent ?? null } }
    : result.response;

  return NextResponse.json(responseBody);
}
