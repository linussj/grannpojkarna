import { withSupabase } from "npm:@supabase/server@1.9.2";
import { corsHeaders } from "npm:@supabase/supabase-js@2.118.0/cors";

const siteUrl = "https://grannpojkarna.se";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
const emailFrom = Deno.env.get("JOB_ALERT_FROM") ?? "Grannpojkarna <notiser@grannpojkarna.se>";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

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

function priceLabel(job: Record<string, unknown>) {
  const amount = new Intl.NumberFormat("sv-SE").format(Number(job.budget_sek) || 0);
  if (job.price_type === "hourly") return `${amount} kr/tim`;
  if (job.price_type === "quote") return `Budget cirka ${amount} kr`;
  return `${amount} kr`;
}

function emailHtml(job: Record<string, unknown>) {
  const title = escapeHtml(job.title);
  const description = escapeHtml(job.description);
  const location = escapeHtml(job.location);
  const timing = escapeHtml(job.timing);
  const price = escapeHtml(priceLabel(job));
  return `<!doctype html><html lang="sv"><body style="margin:0;background:#f3f5f2;font-family:Arial,sans-serif;color:#183227"><div style="max-width:620px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #dce5de;border-radius:18px;padding:28px"><div style="font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#2f6b4f">Nytt jobb som matchar din bevakning</div><h1 style="font-size:26px;line-height:1.2;margin:12px 0 10px">${title}</h1><p style="font-size:16px;line-height:1.55;color:#506158;margin:0 0 20px">${description}</p><div style="padding:16px;border-radius:14px;background:#eef5f0;line-height:1.65"><strong>${location}</strong><br>${timing} · ${price}</div><a href="${siteUrl}/jobb.html" style="display:inline-block;margin-top:22px;padding:13px 18px;border-radius:12px;background:#2f6b4f;color:#fff;text-decoration:none;font-weight:800">Visa jobbet</a></div><p style="font-size:12px;line-height:1.55;color:#718078;padding:0 8px">Du får mejlet eftersom du har en aktiv jobbbevakning. Bevakningen kan pausas eller tas bort under Mitt konto → Min profil.</p></div></body></html>`;
}

function stockholmDateKey(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function alertMatches(alert: Record<string, any>, job: Record<string, any>) {
  const haystack = `${job.title ?? ""} ${job.description ?? ""} ${job.category ?? ""}`.toLowerCase();
  const search = String(alert.search_term ?? "").trim().toLowerCase();
  const location = String(alert.location ?? "").trim().toLowerCase();
  if (search && !haystack.includes(search)) return false;
  if (alert.category && alert.category !== job.category) return false;
  if (location && !String(job.location ?? "").toLowerCase().includes(location)) return false;
  if (alert.min_budget_sek && Number(job.budget_sek) < Number(alert.min_budget_sek)) return false;
  const start = String(job.date_start ?? "");
  const end = String(job.date_end ?? start);
  const today = stockholmDateKey();
  const tomorrow = stockholmDateKey(1);
  const weekEnd = stockholmDateKey(7);
  if (alert.timing === "today" && job.timing !== "Idag" && !(start && start <= today && end >= today)) return false;
  if (alert.timing === "tomorrow" && job.timing !== "Imorgon" && !(start && start <= tomorrow && end >= tomorrow)) return false;
  if (alert.timing === "week" && job.timing !== "Den här veckan" && !(start && start <= weekEnd && end >= today)) return false;
  if (alert.timing === "later" && job.date_start) return false;
  return true;
}

async function sendAlerts(
  supabaseAdmin: any,
  job: Record<string, any>,
  recipients: Array<{ id: string }>,
) {
  for (const profile of recipients) {
    const { data: delivery, error: deliveryError } = await supabaseAdmin
      .from("job_email_deliveries")
      .insert({ job_id: job.id, user_id: profile.id, status: "queued" })
      .select("id")
      .single();
    if (deliveryError?.code === "23505") continue;
    if (deliveryError || !delivery) continue;

    const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(profile.id);
    const email = userData?.user?.email;
    if (userError || !email) {
      await supabaseAdmin.from("job_email_deliveries").update({ status: "failed", error: "Mottagaren saknar en verifierad mejladress.", attempted_at: new Date().toISOString() }).eq("id", delivery.id);
      continue;
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json", "Idempotency-Key": `grannpojkarna-job-${job.id}-user-${profile.id}` },
        body: JSON.stringify({ from: emailFrom, to: [email], reply_to: "info@grannpojkarna.se", subject: `Nytt jobb: ${job.title}`, html: emailHtml(job) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result?.message ?? `Resend ${response.status}`));
      await supabaseAdmin.from("job_email_deliveries").update({ status: "sent", provider_id: result?.id ?? null, error: null, attempted_at: new Date().toISOString(), sent_at: new Date().toISOString() }).eq("id", delivery.id);
    } catch (error) {
      await supabaseAdmin.from("job_email_deliveries").update({ status: "failed", error: String(error instanceof Error ? error.message : error).slice(0, 500), attempted_at: new Date().toISOString() }).eq("id", delivery.id);
    }
  }
}

const authenticatedHandler = withSupabase({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!resendApiKey) return jsonResponse({ error: "Email provider is not configured" }, 503);

  let body: { job_id?: number };
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  const jobId = Number(body.job_id);
  const callerId = String(ctx.userClaims?.sub ?? ctx.userClaims?.id ?? "");
  if (!Number.isSafeInteger(jobId) || jobId < 1 || !callerId) return jsonResponse({ error: "Invalid request" }, 400);

  const { data: job, error: jobError } = await ctx.supabaseAdmin.from("jobs").select("id, user_id, title, description, location, timing, date_start, date_end, budget_sek, price_type, category, status, created_at").eq("id", jobId).maybeSingle();
  if (jobError) return jsonResponse({ error: "Could not load job" }, 500);
  if (!job || job.user_id !== callerId) return jsonResponse({ error: "Forbidden" }, 403);
  const isFresh = Date.now() - new Date(job.created_at).getTime() <= 15 * 60 * 1000;
  if (job.status !== "open" || !isFresh) return jsonResponse({ error: "Job is not eligible for alerts" }, 409);

  const [
    { data: alerts, error: alertsError },
    { data: legacyProfiles, error: profilesError },
    { data: legacyMatches, error: matchesError },
  ] = await Promise.all([
    ctx.supabaseAdmin.from("job_alerts").select("user_id, search_term, category, location, timing, min_budget_sek").eq("email_enabled", true).neq("user_id", job.user_id).limit(500),
    ctx.supabaseAdmin.from("profiles").select("id, email_job_alert_mode").eq("performer_enabled", true).neq("email_job_alert_mode", "off").neq("id", job.user_id).limit(500),
    ctx.supabaseAdmin.from("notifications").select("user_id").eq("job_id", job.id).eq("type", "job_match"),
  ]);
  if (alertsError || profilesError || matchesError) return jsonResponse({ error: "Could not load recipients" }, 500);

  const matchingUserIds = new Set((alerts ?? []).filter((alert) => alertMatches(alert, job)).map((alert) => alert.user_id));
  const legacyMatchingIds = new Set((legacyMatches ?? []).map((item) => item.user_id));
  (legacyProfiles ?? []).forEach((profile) => {
    if (profile.email_job_alert_mode === "all" || legacyMatchingIds.has(profile.id)) matchingUserIds.add(profile.id);
  });
  const recipients = [...matchingUserIds].map((id) => ({ id }));
  EdgeRuntime.waitUntil(sendAlerts(ctx.supabaseAdmin, job, recipients));
  return jsonResponse({ queued: recipients.length }, 202);
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
