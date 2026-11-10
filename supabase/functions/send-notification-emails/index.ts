import { withSupabase } from "npm:@supabase/server@1.9.2";
import { corsHeaders } from "npm:@supabase/supabase-js@2.118.0/cors";

const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const emailFrom = Deno.env.get("JOB_ALERT_FROM") ?? "Grannpojkarna <notiser@grannpojkarna.se>";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

type QueueRow = {
  id: number;
  recipient_user_id: string | null;
  recipient_email: string | null;
  kind: string;
  subject: string;
  body: string;
  action_url: string | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailHtml(row: QueueRow) {
  const title = escapeHtml(row.subject.replace(/^Grannpojkarna:\s*/i, ""));
  const body = escapeHtml(row.body).replaceAll("\n", "<br>");
  const actionUrl = escapeHtml(row.action_url || "https://grannpojkarna.se/konto.html");
  const actionLabel = row.kind === "admin_new_job"
    ? "Visa alla jobb"
    : row.kind.includes("message")
      ? "Öppna meddelanden"
      : row.kind === "test" ? "Öppna Mitt konto" : "Öppna Mina jobb";
  const preheader = row.kind === "admin_new_job" ? "Ett nytt jobb har publicerats" : "Du har en ny händelse på Grannpojkarna";

  return `<!doctype html><html lang="sv"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${title}</title></head><body style="margin:0;background:#f3f5f2;font-family:Arial,sans-serif;color:#183227"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div><div style="max-width:620px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #dce5de;border-radius:18px;padding:28px"><div style="display:inline-block;padding:7px 10px;border-radius:10px;background:#2f6b4f;color:#fff;font-size:14px;font-weight:900">G</div><div style="margin-top:18px;font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#2f6b4f">Grannpojkarna</div><h1 style="font-size:26px;line-height:1.2;margin:10px 0 12px">${title}</h1><p style="font-size:16px;line-height:1.6;color:#506158;margin:0">${body}</p><a href="${actionUrl}" style="display:inline-block;margin-top:22px;padding:13px 18px;border-radius:12px;background:#2f6b4f;color:#fff;text-decoration:none;font-weight:800">${actionLabel}</a></div><p style="font-size:12px;line-height:1.55;color:#718078;padding:0 8px">Det här är ett automatiskt mejl från Grannpojkarna. Du kan pausa användarmejl under Mitt konto → Min profil.</p></div></body></html>`;
}

async function resolveRecipient(supabaseAdmin: any, row: QueueRow) {
  if (row.recipient_email) return row.recipient_email;
  if (!row.recipient_user_id) return null;
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(row.recipient_user_id);
  if (error) return null;
  return data?.user?.email ?? null;
}

async function deliverBatch(supabaseAdmin: any, rows: QueueRow[]) {
  for (const row of rows) {
    try {
      const email = await resolveRecipient(supabaseAdmin, row);
      if (!email) throw new Error("Mottagaren saknar en verifierad mejladress.");
      const result = await sendEmail(row, email, `grannpojkarna-email-${row.id}`);

      await supabaseAdmin
        .from("email_notification_queue")
        .update({
          status: "sent",
          provider_id: result?.id ?? null,
          sent_at: new Date().toISOString(),
          processing_started_at: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    } catch (error) {
      await supabaseAdmin
        .from("email_notification_queue")
        .update({
          status: "failed",
          processing_started_at: null,
          available_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          last_error: String(error instanceof Error ? error.message : error).slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
  }
}

async function sendEmail(row: QueueRow, email: string, idempotencyKey: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [email],
      reply_to: "info@grannpojkarna.se",
      subject: row.subject,
      html: emailHtml(row),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result?.message ?? `Resend ${response.status}`));
  return result;
}

const authenticatedHandler = withSupabase({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!resendApiKey) return jsonResponse({ error: "Email provider is not configured" }, 503);

  const requestBody = await req.json().catch(() => ({}));
  if (requestBody?.test === true) {
    const callerId = String(ctx.userClaims?.sub ?? ctx.userClaims?.id ?? "");
    if (!callerId) return jsonResponse({ error: "Authenticated user is missing" }, 401);
    const { data: userData, error: userError } = await ctx.supabaseAdmin.auth.admin.getUserById(callerId);
    const email = userData?.user?.email ?? null;
    if (userError || !email) return jsonResponse({ error: "User email is missing" }, 400);
    const row: QueueRow = {
      id: 0,
      recipient_user_id: callerId,
      recipient_email: email,
      kind: "test",
      subject: "Test av e-postnotiser",
      body: "Det fungerar! Du kommer att få mejl om viktiga händelser på Grannpojkarna.",
      action_url: "https://grannpojkarna.se/konto.html",
    };
    try {
      await sendEmail(row, email, `grannpojkarna-test-${callerId}-${crypto.randomUUID()}`);
      return jsonResponse({ sent: true, email });
    } catch (error) {
      return jsonResponse({ error: String(error instanceof Error ? error.message : error).slice(0, 500) }, 502);
    }
  }

  const { data, error } = await ctx.supabaseAdmin.rpc("claim_email_notification_batch", { p_limit: 25 });
  if (error) return jsonResponse({ error: "Could not claim email queue" }, 500);
  const rows = (data ?? []) as QueueRow[];
  if (rows.length) EdgeRuntime.waitUntil(deliverBatch(ctx.supabaseAdmin, rows));
  return jsonResponse({ queued: rows.length }, 202);
});

export default {
  async fetch(req: Request) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    const response = await authenticatedHandler(req);
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
