import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const reply = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Método no permitido." }, 405);
  try {
    const raw = await req.text();
    if (raw.length > 4000) return reply({ error: "Solicitud demasiado larga." }, 413);
    const body = JSON.parse(raw);
    if (typeof body?.tracking !== "string" || !/^[0-9a-f]{64}$/.test(body.tracking)) {
      return reply({ error: "Referencia de registro inválida." }, 400);
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.tracking));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const lookup = async () => {
      const { data, error } = await admin.rpc("tarraco_registration_status", { p_hash: hash });
      if (error) throw error;
      return data as string | null;
    };

    if (body.action === "status") return reply({ status: await lookup() ?? "unavailable" });
    if (body.action !== "register") return reply({ error: "Acción no válida." }, 400);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const company = typeof body.company === "string" ? body.company.trim() : "";
    const contact = typeof body.contact === "string" ? body.contact.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || password.length < 8 || new TextEncoder().encode(password).length > 72
      || company.length < 2 || company.length > 120 || contact.length < 2 || contact.length > 120
      || phone.length < 7 || phone.length > 25) {
      return reply({ error: "Revisa los datos y usa una contraseña de al menos 8 caracteres y hasta 72 bytes." }, 400);
    }

    const previous = await lookup();
    if (previous) return reply({ status: previous });
    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      app_metadata: { tarraco_registration_hash: hash },
      user_metadata: { company_name: company, contact_name: contact, contact_phone: phone },
    });
    const status = await lookup();
    if (status) return reply({ status });
    if (error) {
      return reply({ error: "No se pudo registrar la solicitud. Si ya tienes una cuenta o una solicitud, contacta con TARRACO. Si no, vuelve a intentarlo más tarde." }, 400);
    }
    return reply({ error: "No se pudo comprobar que la solicitud se haya registrado." }, 503);
  } catch (error) {
    if (error instanceof SyntaxError) return reply({ error: "Solicitud no válida." }, 400);
    console.error("No se pudo procesar el registro de TARRACO.");
    return reply({ error: "No se pudo procesar la solicitud. Vuelve a intentarlo." }, 503);
  }
});
