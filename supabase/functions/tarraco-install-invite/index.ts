import { createClient } from "npm:@supabase/supabase-js@2.95.3";
import { html, subject, text } from "./email.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const logFields = "id, company_name, recipient, requested_at, status, detail";
const reply = (status: number, data: object) => Response.json(data, { status, headers: cors });
type Company = { id: string; name: string; email: string | null };
type DeliveryStatus = "sent" | "failed" | "unknown";

async function deliver(from: string, key: string, recipient: string, id: string) {
  let status: DeliveryStatus = "unknown";
  let detail: string | null = "El proveedor no confirmó el resultado del envío.";
  let providerId: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "Idempotency-Key": "tarraco-install/" + id,
      },
      body: JSON.stringify({ from, to: [recipient], subject, html, text }),
      signal: AbortSignal.timeout(7500),
    });
    if (response.ok) {
      const data = await response.json();
      if (typeof data.id === "string" && data.id) {
        status = "sent";
        detail = null;
        providerId = data.id;
      }
    } else if (response.status < 500 && response.status !== 408) {
      status = "failed";
      detail = response.status === 429
        ? "El proveedor ha alcanzado su límite de envío."
        : "El proveedor rechazó el correo (" + response.status + ").";
    }
  } catch { /* A timeout can happen after the provider accepts the email. */ }
  return { status, detail, provider_id: providerId };
}

async function sendCompany(company: Company, campaign: string, userId: string, from: string, key: string) {
  const recipient = company.email?.trim().toLowerCase() || "";
  if (recipient.length > 254 || !email.test(recipient)) return "skipped";
  const { data: row, error } = await db.from("tarraco_install_invites").upsert({
    campaign_id: campaign, requested_by: userId, company_id: company.id,
    company_name: company.name, recipient,
  }, { onConflict: "campaign_id,recipient", ignoreDuplicates: true }).select("id").maybeSingle();
  if (error) throw error;
  if (!row) return "skipped";

  const outcome = await deliver(from, key, recipient, row.id);
  const { error: saveError } = await db.from("tarraco_install_invites").update(outcome).eq("id", row.id);
  if (saveError) throw saveError;
  return outcome.status;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return reply(405, { error: "Método no permitido." });
  const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return reply(401, { error: "Inicia sesión para continuar." });
  try {
    const { data: auth, error: authError } = await db.auth.getUser(token);
    if (authError || !auth.user) return reply(401, { error: "La sesión ha caducado." });
    const { data: profile, error: profileError } = await db.from("profiles").select("role")
      .eq("id", auth.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== "admin") return reply(403, { error: "Acceso reservado a administración." });

    const body = await request.json().catch(() => null);
    if (body?.action !== "status" && body?.action !== "send") return reply(400, { error: "Acción no válida." });
    const { data: config, error: configError } = await db.from("notification_settings")
      .select("sender_email").eq("id", 1).maybeSingle();
    if (configError) throw configError;
    const key = Deno.env.get("RESEND_API_KEY")?.trim();
    const from = config?.sender_email?.trim();
    if (body.action === "status") {
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
        return reply(400, { error: "Página de historial no válida." });
      }
      const { data: rows, error } = await db.from("tarraco_install_invites").select(logFields)
        .order("requested_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 24);
      if (error) throw error;
      return reply(200, {
        configured: !!(key && from),
        rows: rows.map(row => row.status === "processing" && Date.now() - Date.parse(row.requested_at) > 90000
          ? { ...row, status: "unknown", detail: "El envío se interrumpió antes de confirmar el resultado." }
          : row),
      });
    }
    if (!key || !from) return reply(503, { error: "El remitente de correo no está disponible. Puedes copiar el enlace o compartir el QR." });
    if (!uuid(body.campaign) || !Array.isArray(body.companies) || !body.companies.length ||
        body.companies.length > 4 || !body.companies.every(uuid)) {
      return reply(400, { error: "Selección de empresas no válida." });
    }

    const { data: companies, error } = await db.from("companies").select("id, name, email")
      .in("id", body.companies).eq("active", true).eq("registration_pending", false);
    if (error) throw error;
    const counts = { sent: 0, failed: 0, unknown: 0, skipped: new Set(body.companies).size - companies.length };
    for (const company of companies) {
      counts[await sendCompany(company, body.campaign, auth.user.id, from, key)]++;
      // Spread requests across the shared provider's per-second quota.
      if (companies.length > 1) await new Promise(resolve => setTimeout(resolve, 550));
    }
    return reply(200, counts);
  } catch {
    console.error("No se pudo completar la consulta o el envío de invitaciones de TARRACO.");
    return reply(500, { error: "No se pudo completar la operación. Consulta el historial antes de repetir el envío." });
  }
});
