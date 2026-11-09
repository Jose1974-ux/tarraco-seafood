import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const token = Deno.env.get("TELEGRAM_IMPORTANT_BOT_TOKEN");
const chatId = Deno.env.get("TELEGRAM_URGENT_CHAT_ID") || Deno.env.get("TELEGRAM_CHAT_ID") || "496937588";
const portal = "https://tarraco-pedidos-portal.vercel.app/";
const webhook = url + "/functions/v1/tarraco-telegram";
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

async function telegram(method: string, body: Record<string, unknown> = {}) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (method === "editMessageText" && result.description?.includes("message is not modified")) return;
  if (!response.ok || !result.ok) throw new Error("Telegram " + method + " (" + response.status + ")");
  return result.result;
}

type RegistrationCompany = {
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
};

const registrationFields = "name,contact_name,phone,email";

function registrationDetails(company: RegistrationCompany) {
  return "Empresa: " + company.name + "\nContacto: " + (company.contact_name ?? "—") +
    "\nTeléfono: " + (company.phone ?? "—") + "\nCorreo: " + (company.email ?? "—");
}

function markRegistrationDecision(chat: number, message: number, company: RegistrationCompany, authorized: boolean) {
  return telegram("editMessageText", {
    chat_id: chat,
    message_id: message,
    text: (authorized ? "✅ Cuenta autorizada" : "❌ Solicitud rechazada") + "\n\n" + registrationDetails(company),
    reply_markup: { inline_keyboard: [[{ text: "Ver empresas en Tarraco", url: portal + "#solicitudes" }]] },
  });
}

function nextAttempt(attempts: number) {
  return new Date(Date.now() + Math.min(60, 2 ** Math.min(attempts, 6)) * 60000).toISOString();
}

async function destination() {
  const chat = await telegram("getChat", { chat_id: chatId });
  if (chat.type === "private") return chat;
  if (!["channel", "group", "supergroup"].includes(chat.type) || chat.username || chat.active_usernames?.length) {
    throw new Error("El destino de Telegram debe ser privado");
  }
  return chat;
}

async function ensureWebhook(secret: string) {
  const current = await telegram("getWebhookInfo");
  if (current.url && current.url !== webhook) return false;
  if (!current.url) {
    await telegram("setWebhook", { url: webhook, secret_token: secret, allowed_updates: ["callback_query"] });
  }
  return true;
}

async function sendAlerts(secret: string, diagnostic: boolean) {
  const chat = await destination();
  const approvalEnabled = await ensureWebhook(secret);
  if (diagnostic) {
    const bot = await telegram("getMe");
    return { bot: bot.first_name, destination: chat.type, approvalEnabled };
  }

  const { data: jobs, error } = await admin.rpc("tarraco_claim_telegram");
  if (error) throw error;
  let sent = 0;
  for (const job of jobs) {
    let lastError = null;
    let registrationMessage = {};
    try {
      if (job.kind === "registration") {
        const { data: company, error } = await admin.from("companies")
          .select("name,contact_name,phone,email,registration_pending").eq("id", job.entity_id).maybeSingle();
        if (error) throw error;
        if (company?.registration_pending) {
          const buttons = [[{ text: "Ver solicitud en Tarraco", url: portal + "#solicitudes" }]];
          const notice = await telegram("sendMessage", {
            chat_id: chat.id,
            text: "🔔 Nueva solicitud de registro · Pendiente de autorización\n\n" + registrationDetails(company),
            protect_content: true,
            reply_markup: { inline_keyboard: approvalEnabled
              ? [[
                { text: "Autorizar registro", callback_data: "alta:" + job.entity_id },
                { text: "Rechazar registro", callback_data: "rechazar:" + job.entity_id },
              ], ...buttons]
              : buttons },
          });
          registrationMessage = { telegram_chat_id: chat.id, telegram_message_id: notice.message_id };
        }
      } else if (job.kind === "registration_authorized") {
        const { data: notice, error: noticeError } = await admin.from("tarraco_telegram_outbox")
          .select("sent_at,telegram_chat_id,telegram_message_id")
          .eq("kind", "registration").eq("entity_id", job.entity_id).maybeSingle();
        if (noticeError) throw noticeError;
        if (notice && !notice.sent_at) throw new Error("El aviso de alta todavía se está procesando");
        if (notice?.telegram_message_id && notice.telegram_chat_id === chat.id) {
          const { data: company, error } = await admin.from("companies")
            .select("name,contact_name,phone,email,active").eq("id", job.entity_id).maybeSingle();
          if (error) throw error;
          if (company?.active) await markRegistrationDecision(chat.id, notice.telegram_message_id, company, true);
        }
      } else {
        const { data: message, error } = await admin.from("company_chat_messages")
          .select("company_id,sender_is_admin").eq("id", job.entity_id).maybeSingle();
        if (error) throw error;
        if (message && !message.sender_is_admin) {
          const { data: company, error } = await admin.from("companies")
            .select("name").eq("id", message.company_id).maybeSingle();
          if (error) throw error;
          if (company) await telegram("sendMessage", {
            chat_id: chat.id,
            text: "💬 Nuevo mensaje de " + company.name + " en Tarraco Pedidos.",
            protect_content: true,
            reply_markup: { inline_keyboard: [[{ text: "Abrir conversación", url: portal + "#mensajes/" + message.company_id }]] },
          });
        }
      }
      sent++;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Error al avisar";
    }
    const patch = lastError
      ? { last_error: lastError, next_attempt_at: nextAttempt(job.attempts) }
      : { last_error: null, sent_at: new Date().toISOString(), ...registrationMessage };
    const { error: saveError } = await admin.from("tarraco_telegram_outbox").update(patch)
      .eq("kind", job.kind).eq("entity_id", job.entity_id).eq("attempts", job.attempts);
    if (saveError) throw saveError;
  }
  return { sent, approvalEnabled };
}

async function decideRegistration(callback: {
  id: string;
  data?: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
}) {
  const match = callback.data?.match(/^(alta|rechazar):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  if (!match || !callback.message) return;
  const answer = (text: string) => telegram("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: true });
  const chat = await destination();
  if (chat.id !== callback.message.chat.id) {
    await answer("Abre el aviso original en el chat autorizado.");
    return;
  }
  const allowed = chat.type === "private" ? callback.from.id === chat.id
    : ["creator", "administrator"].includes(
      (await telegram("getChatMember", { chat_id: chat.id, user_id: callback.from.id })).status,
    );
  if (!allowed) {
    await answer("Solo administración puede resolver solicitudes.");
    return;
  }
  const { data: decision, error } = await admin.rpc("tarraco_decide_registration", {
    p_company: match[2],
    p_approve: match[1] === "alta",
  });
  if (error) throw error;
  if (decision !== "authorized" && decision !== "rejected") {
    await answer("La solicitud ya no está disponible.");
    return;
  }
  const { data: company, error: lookupError } = await admin.from("companies")
    .select(registrationFields).eq("id", match[2]).maybeSingle();
  if (lookupError) throw lookupError;
  const authorized = decision === "authorized";
  await answer(authorized ? "Cuenta autorizada en Tarraco Pedidos." : "Solicitud rechazada.").catch(() => {});
  if (company) await markRegistrationDecision(chat.id, callback.message.message_id, company, authorized);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const webhookSecret = req.headers.get("x-telegram-bot-api-secret-token");
  const workerSecret = req.headers.get("x-tarraco-worker");
  const secret = webhookSecret || workerSecret;
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) return new Response(null, { status: 401 });
  try {
    const { data: authorized, error } = await admin.rpc("tarraco_telegram_worker_authorized", { p_secret: secret });
    if (error || !authorized) return new Response(null, { status: 401 });
    const payload = await req.json();
    if (!token) {
      return Response.json({ error: "Falta el bot de avisos urgentes" }, { status: 503 });
    }
    if (webhookSecret) {
      if (payload.callback_query) await decideRegistration(payload.callback_query);
      return Response.json({ ok: true });
    }
    return Response.json(await sendAlerts(secret, payload.diagnostic === true));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Error en Telegram");
    return Response.json({ error: "No se pudo procesar el aviso de Telegram" }, { status: 502 });
  }
});
