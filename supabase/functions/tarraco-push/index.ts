import { createClient } from "npm:@supabase/supabase-js@2.95.3";
// @ts-types="npm:@types/web-push@3.6.4"
import webpush from "npm:web-push@3.6.7";

const url = Deno.env.get("SUPABASE_URL")!;
const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
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
const kinds = ["pedido", "registro", "mensaje", "reparto", "prueba"];

function reply(status: number, data: object) {
  return Response.json(data, { status, headers: cors });
}

function unwrap<T>({ data, error }: { data: T; error: unknown }): T {
  if (error) throw new Error("database");
  return data;
}

function endpointAllowed(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  try {
    const target = new URL(endpoint);
    return target.origin === "https://fcm.googleapis.com" &&
      !target.username && !target.password && !target.search && !target.hash &&
      /^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:\-.]+$/.test(target.pathname);
  } catch {
    return false;
  }
}

function validKey(value: unknown, size: number) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value) ||
      value.length !== Math.ceil(size * 8 / 6)) return false;
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return decoded.length === size && (size !== 65 || decoded.charCodeAt(0) === 4);
}

async function dispatch(secret: string) {
  if (!/^[0-9a-f]{64}$/.test(secret)) return reply(401, { error: "Acceso requerido." });
  const [keys] = unwrap(await db.rpc("tarraco_push_worker_keys", { p_secret: secret }));
  if (!keys) return reply(403, { error: "Acceso denegado." });
  const jobs = unwrap(await db.rpc("tarraco_push_claim"));
  await Promise.all(jobs.map(async (job: {
    id: string; device_id: string; kind: string; entity_id: string; company_id: string | null;
    round: number; failures: number; lease: string; endpoint: string; p256dh: string;
    auth_key: string; sound: boolean;
  }) => {
    // Recheck the lease and live admin session immediately before contacting FCM.
    const current = unwrap(await db.from("tarraco_push_deliveries").select("id, tarraco_push_devices!inner(user_id,session_id,sound)")
      .eq("id", job.id).eq("lease", job.lease).is("opened_at", null).maybeSingle());
    if (!current) return;
    const device = current.tarraco_push_devices as unknown as { user_id: string; session_id: string; sound: boolean };
    if (!unwrap(await db.rpc("tarraco_push_admin_session", { p_user: device.user_id, p_session: device.session_id }))) return;
    let status = 0;
    if (!endpointAllowed(job.endpoint)) {
      status = 410;
    } else {
      try {
        await webpush.sendNotification({
          endpoint: job.endpoint,
          keys: { p256dh: job.p256dh, auth: job.auth_key },
        }, JSON.stringify({
          type: job.kind, id: job.entity_id, company: job.company_id,
          delivery: job.id, round: job.round, sound: device.sound,
        }), {
          TTL: 300, urgency: "high", topic: job.id.replace(/-/g, ""), timeout: 8000,
          vapidDetails: { subject: url, publicKey: keys.public_key, privateKey: keys.private_key },
        });
        status = 201;
      } catch (error) {
        status = Number((error as { statusCode?: number }).statusCode) || 0;
      }
    }
    if (status === 404 || status === 410) {
      unwrap(await db.from("tarraco_push_devices").delete()
        .eq("id", job.device_id).eq("endpoint", job.endpoint).eq("session_id", device.session_id));
      return;
    }
    const sent = status === 201;
    const delay = sent ? 300 : Math.min(300, 30 * 2 ** Math.min(4, job.failures));
    unwrap(await db.from("tarraco_push_deliveries").update({
      lease: null, due_at: new Date(Date.now() + delay * 1000).toISOString(),
      round: job.round + Number(sent), failures: sent ? 0 : Math.min(10, job.failures + 1),
    }).eq("id", job.id).eq("lease", job.lease).is("opened_at", null));
  }));
  return reply(200, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Método no permitido." });
  const worker = req.headers.get("x-tarraco-push-worker");
  if (worker) {
    try {
      return await dispatch(worker);
    } catch {
      return reply(503, { error: "No se pudo completar el envío." });
    }
  }
  let body;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return reply(413, { error: "Solicitud demasiado grande." });
    body = JSON.parse(raw);
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return reply(400, { error: "Solicitud no válida." });
  }
  try {
    // A push click can acknowledge only its unguessable delivery, even without an open page.
    if (body.action === "open") {
      if (!uuid(body.delivery)) return reply(400, { error: "Aviso no válido." });
      unwrap(await db.rpc("tarraco_push_open", { p_delivery: body.delivery }));
      return reply(200, { ok: true });
    }

    const token = req.headers.get("Authorization")?.match(/^Bearer ([\w.-]+)$/i)?.[1];
    if (!token) return reply(401, { error: "Inicia sesión en administración." });
    const { data: identity, error } = await db.auth.getUser(token);
    if (error || !identity.user) return reply(401, { error: "Sesión no válida." });
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const session = JSON.parse(atob(encoded)).session_id;
    const user = identity.user.id;
    if (!uuid(session) || !unwrap(await db.rpc("tarraco_push_admin_session", { p_user: user, p_session: session }))) {
      return reply(403, { error: "Acceso solo para administración." });
    }

    if (body.action === "key") {
      const { publicKey, privateKey } = webpush.generateVAPIDKeys();
      const key = unwrap(await db.rpc("tarraco_push_configure", { p_public: publicKey, p_private: privateKey, p_url: url }));
      return reply(200, { key });
    }
    if (body.action === "read" && kinds.includes(body.kind) && uuid(body.id)) {
      unwrap(await db.rpc("tarraco_push_read", { p_user: user, p_kind: body.kind, p_entity: body.id }));
      return reply(200, { ok: true });
    }
    const endpoint = body.endpoint;
    if (!endpointAllowed(endpoint)) return reply(400, { error: "Suscripción no compatible. Abre el portal en Chrome." });
    const owned = db.from("tarraco_push_devices").select("id,sound")
      .eq("endpoint", endpoint).eq("user_id", user).eq("session_id", session);
    if (body.action === "subscribe") {
      if (!validKey(body.p256dh, 65) || !validKey(body.auth, 16) || typeof body.sound !== "boolean") {
        return reply(400, { error: "Suscripción no válida." });
      }
      // Existing subscriptions can move to a new login session for the same administrator only.
      unwrap(await db.from("tarraco_push_devices").upsert({
        endpoint, user_id: user, session_id: session, p256dh: body.p256dh, auth_key: body.auth, sound: body.sound,
      }, { onConflict: "endpoint", ignoreDuplicates: true }));
      const device = unwrap(await db.from("tarraco_push_devices").update({
        session_id: session, p256dh: body.p256dh, auth_key: body.auth, sound: body.sound,
      }).eq("endpoint", endpoint).eq("user_id", user).select("id").maybeSingle());
      return device ? reply(200, { ok: true }) : reply(409, { error: "La suscripción pertenece a otra cuenta. Desactívala y vuelve a activarla." });
    }
    if (body.action === "disable") {
      unwrap(await db.from("tarraco_push_devices").delete().eq("endpoint", endpoint)
        .eq("user_id", user).eq("session_id", session));
      return reply(200, { ok: true });
    }
    if (body.action === "status") {
      const device = unwrap(await owned.maybeSingle());
      return reply(200, { enabled: !!device, sound: device?.sound ?? true });
    }
    if (body.action === "sound" && typeof body.sound === "boolean") {
      const device = unwrap(await db.from("tarraco_push_devices").update({ sound: body.sound })
        .eq("endpoint", endpoint).eq("user_id", user).eq("session_id", session).select("id").maybeSingle());
      return device ? reply(200, { ok: true }) : reply(409, { error: "Activa primero los avisos en este dispositivo." });
    }
    if (body.action === "test") {
      const device = unwrap(await owned.maybeSingle());
      const ok = device && unwrap(await db.rpc("tarraco_push_test", { p_user: user, p_device: device.id }));
      return ok ? reply(200, { ok: true }) : reply(429, { error: "Activa los avisos o espera un minuto entre pruebas." });
    }
    return reply(400, { error: "Acción no válida." });
  } catch {
    return reply(503, { error: "No se pudo completar la operación de avisos." });
  }
});
