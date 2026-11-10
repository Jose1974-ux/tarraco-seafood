import { createClient } from "npm:@supabase/supabase-js@2.95.3";

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
const field = (value: unknown) => typeof value === "string" ? value.trim() : "";
const validCode = (value: string) => /^[\p{L}\p{N}][\p{L}\p{N}. -]{0,39}$/u.test(value);

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
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const lookup = async () => {
      const { data, error } = await admin.rpc("tarraco_registration_status", { p_hash: hash });
      if (error) throw error;
      return data as string | null;
    };
    if (body.action === "status") return reply({ status: await lookup() ?? "unavailable" });
    if (body.action === "confirm_existing_code") {
      const code = field(body.code);
      if (!validCode(code)) return reply({ error: "Introduce un código de cliente válido." }, 400);
      const { data, error } = await admin.rpc("tarraco_registration_confirm_code", { p_hash: hash, p_code: code });
      if (error) throw error;
      return reply({ status: data ?? "unavailable" });
    }
    if (body.action === "code") {
      const code = field(body.code);
      if (!validCode(code)) return reply({ error: "Revisa el código de cliente e inténtalo de nuevo." }, 400);
      const { data, error } = await admin.rpc("tarraco_registration_add_code", { p_hash: hash, p_code: code });
      if (error) throw error;
      return reply({ status: data ?? "unavailable" });
    }
    if (body.action !== "register") return reply({ error: "Acción no válida." }, 400);

    const email = field(body.email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const restaurant = field(body.company);
    const tax = field(body.tax);
    const phone = field(body.phone);
    const code = field(body.code);
    const isNew = body.newCustomer === true;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || Array.from(password).length < 8 || new TextEncoder().encode(password).length > 72
      || restaurant.length < 2 || restaurant.length > 120
      || !/^[A-Za-z0-9][A-Za-z0-9. -]{5,19}$/.test(tax)
      || !/^[+0-9 .()-]{7,25}$/.test(phone) || phone.replace(/\D/g, "").length < 7
      || (code && (!validCode(code) || isNew))) {
      return reply({ error: "Revisa el nombre, el NIF/CIF, el teléfono y el correo. La contraseña debe tener al menos 8 caracteres." }, 400);
    }

    const previous = await lookup();
    if (previous) return reply({ status: previous });
    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      app_metadata: { tarraco_link_registration_hash: hash },
      user_metadata: { restaurant_name: restaurant, tax_id: tax, contact_phone: phone, customer_code: code, new_customer: isNew },
    });
    const status = await lookup();
    if (status) return reply({ status });
    if (error) {
      return reply({ error: "No se pudo registrar la solicitud. Si ya tienes cuenta, prueba a iniciar sesión. Si el problema continúa, contacta con TARRACO." }, 400);
    }
    return reply({ error: "No se pudo comprobar la solicitud. Vuelve a intentarlo." }, 503);
  } catch (error) {
    if (error instanceof SyntaxError) return reply({ error: "Solicitud no válida." }, 400);
    console.error("No se pudo procesar el registro de TARRACO.");
    return reply({ error: "No se pudo procesar la solicitud. Vuelve a intentarlo." }, 503);
  }
});
