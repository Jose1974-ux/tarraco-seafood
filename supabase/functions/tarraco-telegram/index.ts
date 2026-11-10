import { createClient } from "npm:@supabase/supabase-js@2.95.3";

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

type LinkNotice = {
  name: string;
  tax_id: string;
  phone: string;
  email: string;
  link_state: "matched" | "new" | "review";
  candidate_name: string | null;
  candidate_code: string | null;
  state: string;
};

async function linkNotice(id: string): Promise<LinkNotice | null> {
  const { data, error } = await admin.rpc("tarraco_registration_link_notice", { p_notice: id });
  if (error) throw error;
  return data?.[0] ?? null;
}

function linkNoticeDetails(notice: LinkNotice) {
  const result = notice.link_state === "matched" && notice.candidate_code
    ? "Ficha propuesta: " + notice.candidate_name + " · Código " + notice.candidate_code
    : notice.link_state === "new"
    ? "Cliente nuevo · Se creará su ficha al autorizar."
    : "Vínculo pendiente · No hay una ficha que se pueda autorizar con estos datos.";
  return "Restaurante: " + notice.name + "\nNIF/CIF: " + notice.tax_id +
    "\nTeléfono: " + notice.phone + "\nCorreo: " + notice.email + "\n\n" + result;
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

type OrderNotice = {
  id: string;
  company_id: string;
  status: string;
  created_at: string;
  requested_date: string | null;
  fulfilment: string;
  customer_notes: string | null;
  changed_at?: string;
  items: {
    product_name_snapshot: string;
    quantity: number;
    unit_snapshot: string;
    preparation_notes: string | null;
  }[];
};

const orderTimestamp = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short",
});
const orderUnits: Record<string, string> = {
  kg: "kg", unit: "piezas", box: "cajas", sack: "sacos", bag: "bolsas", dozen: "docenas",
};
const orderStatuses: Record<string, string> = {
  pending: "Pendiente de confirmación", confirmed: "Confirmado", preparing: "Recibido y en preparación",
  ready_for_pickup: "Listo para recoger", shipped: "Enviado", delivered: "Entregado",
  cancelled: "Cancelado", rejected: "Rechazado",
};

async function sendOrderNotice(chat: number, job: {
  kind: string; entity_id: string; order_snapshot: OrderNotice | null;
}, webhookEnabled: boolean) {
  let order = job.order_snapshot;
  if (job.kind === "order_received_request") {
    const { data, error } = await admin.from("orders").select(
      "id,company_id,status,created_at,requested_date,fulfilment,customer_notes,tarraco_received_at,items:order_items(product_name_snapshot,quantity,unit_snapshot,preparation_notes)",
    ).eq("id", job.entity_id).maybeSingle();
    if (error) throw error;
    if (!data || data.tarraco_received_at || !["pending", "confirmed", "preparing"].includes(data.status)) return;
    order = data;
    if (!webhookEnabled) throw new Error("El bot no tiene habilitada la confirmación de pedidos");
  }
  if (!order) throw new Error("Falta el detalle del pedido");
  const { data: company, error } = await admin.from("companies").select("name")
    .eq("id", order.company_id).maybeSingle();
  if (error) throw error;

  const updated = job.kind === "order_updated";
  const header = updated ? "✏️ Pedido modificado por el cliente" : "🔔 Nuevo pedido · Confirmación de TARRACO";
  const ref = order.id.slice(0, 8).toUpperCase();
  const delivery = order.requested_date?.split("-").reverse().join("/") || "Sin fecha registrada";
  const summary = [
    header, "Pedido " + ref + " · " + (company?.name || "Empresa"),
    "Fecha del pedido: " + orderTimestamp.format(new Date(order.created_at)),
    "Fecha de entrega: " + delivery + " · " + (order.fulfilment === "pickup" ? "Recogida" : "Envío"),
    "Estado: " + (orderStatuses[order.status] || order.status),
    ...(order.changed_at ? ["Modificado: " + orderTimestamp.format(new Date(order.changed_at))] : []),
    ...(order.customer_notes ? ["Observaciones: " + order.customer_notes] : []),
    "", updated ? "Artículos tras la modificación:" : "Artículos:",
    ...order.items.map((item) =>
      "• " + item.product_name_snapshot + " — " + item.quantity + " " +
      (orderUnits[item.unit_snapshot] || item.unit_snapshot) +
      (item.preparation_notes ? " · Preparación: " + item.preparation_notes : "")),
  ].join("\n");
  const links = [[{ text: "Abrir pedido en Tarraco", url: portal + "?aviso=pedido&aviso_id=" + order.id }]];
  const buttons = updated ? links : [[{ text: "Confirmar recepción del pedido", callback_data: "pedido:" + order.id }], ...links];

  // Keep the complete details even when a long order exceeds Telegram's message limit.
  const characters = Array.from(summary);
  for (let offset = 0; offset < characters.length; offset += 1850) {
    await telegram("sendMessage", {
      chat_id: chat,
      text: (offset ? "Pedido " + ref + " · continuación\n" : "") + characters.slice(offset, offset + 1850).join(""),
      protect_content: true,
      ...(offset === 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }
}

type TelegramCallback = {
  id: string;
  data?: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
};

async function canUseCallback(chat: { id: number; type: string }, callback: TelegramCallback) {
  if (callback.message?.chat.id !== chat.id) return false;
  if (chat.type === "private") return callback.from.id === chat.id;
  const member = await telegram("getChatMember", { chat_id: chat.id, user_id: callback.from.id });
  return ["creator", "administrator"].includes(member.status);
}

async function confirmOrder(callback: TelegramCallback) {
  const id = callback.data?.match(/^pedido:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/)?.[1];
  if (!id || !callback.message) return;
  const answer = (text: string) => telegram("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: true });
  const chat = await destination();
  if (!await canUseCallback(chat, callback)) {
    await answer("Solo administración puede confirmar pedidos en el chat autorizado.");
    return;
  }
  const { data: status, error } = await admin.rpc("tarraco_confirm_order_reception", { p_order: id });
  if (error) throw error;
  if (status !== "preparing") {
    await answer(status ? "El pedido está en estado " + (orderStatuses[status] || status) + "." : "El pedido ya no está disponible.");
    return;
  }
  await answer("Pedido recibido y en preparación. El cliente ya puede ver la confirmación.").catch(() => {});
  await telegram("editMessageReplyMarkup", {
    chat_id: chat.id, message_id: callback.message.message_id,
    reply_markup: { inline_keyboard: [[{
      text: "✓ Recepción confirmada · Ver pedido", url: portal + "?aviso=pedido&aviso_id=" + id,
    }]] },
  }).catch(() => {});
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
      if (job.kind === "registration_link") {
        const notice = await linkNotice(job.entity_id);
        if (notice?.state === "pending") {
          if (!approvalEnabled) throw new Error("Webhook de autorización no disponible");
          const buttons = [{ text: "Rechazar", callback_data: "nl:no:" + job.entity_id }];
          if (notice.link_state !== "review" && (notice.link_state === "new" || notice.candidate_code)) {
            buttons.unshift({ text: "Autorizar", callback_data: "nl:si:" + job.entity_id });
          }
          const sentNotice = await telegram("sendMessage", {
            chat_id: chat.id,
            text: "🔔 Solicitud de acceso a TARRACO\n\n" + linkNoticeDetails(notice),
            protect_content: true,
            reply_markup: { inline_keyboard: [buttons, [{
              text: "Ver solicitudes en Tarraco", url: portal + "#solicitudes",
            }]] },
          });
          registrationMessage = { telegram_chat_id: chat.id, telegram_message_id: sentNotice.message_id };
        }
      } else if (job.kind === "registration") {
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
      } else if (job.kind === "order_received_request" || job.kind === "order_updated") {
        await sendOrderNotice(chat.id, job, approvalEnabled);
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

async function decideRegistrationLink(callback: TelegramCallback) {
  const match = callback.data?.match(/^nl:(si|no):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  if (!match || !callback.message) return;
  const chat = await destination();
  const answer = (text: string) => telegram("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: true });
  if (!await canUseCallback(chat, callback)) {
    await answer("Solo administración puede resolver solicitudes en el chat autorizado.");
    return;
  }
  const { data: decision, error } = await admin.rpc("tarraco_decide_registration_link", {
    p_notice: match[2], p_approve: match[1] === "si",
  });
  if (error) throw error;
  if (decision === "review") {
    await answer("La coincidencia requiere revisión. El acceso sigue pendiente.");
    await telegram("editMessageReplyMarkup", {
      chat_id: chat.id, message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: "Rechazar", callback_data: "nl:no:" + match[2] }]] },
    }).catch(() => {});
    return;
  }
  if (decision !== "authorized" && decision !== "rejected" && decision !== "code_pending") {
    await answer("Este aviso ya no está disponible. Comprueba si hay una solicitud más reciente.");
    return;
  }
  const authorized = decision === "authorized";
  const awaitingCode = decision === "code_pending";
  await answer(awaitingCode ? "Solicitud aprobada. El cliente debe confirmar su código original antes de entrar." : authorized ? "Cuenta autorizada. El cliente ya puede iniciar sesión." : "Solicitud rechazada.").catch(() => {});
  const notice = await linkNotice(match[2]);
  if (notice) await telegram("editMessageText", {
    chat_id: chat.id, message_id: callback.message.message_id,
    text: (awaitingCode ? "🔐 Solicitud aprobada · Pendiente de confirmar código" : authorized ? "✅ Cuenta autorizada" : "❌ Solicitud rechazada") + "\n\n" + linkNoticeDetails(notice),
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

async function decideRegistration(callback: TelegramCallback) {
  const match = callback.data?.match(/^(alta|rechazar):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/);
  if (!match || !callback.message) return;
  const answer = (text: string) => telegram("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: true });
  const chat = await destination();
  if (chat.id !== callback.message.chat.id) {
    await answer("Abre el aviso original en el chat autorizado.");
    return;
  }
  if (!await canUseCallback(chat, callback)) {
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
      if (payload.callback_query?.data?.startsWith("pedido:")) await confirmOrder(payload.callback_query);
      else if (payload.callback_query?.data?.startsWith("nl:")) await decideRegistrationLink(payload.callback_query);
      else if (payload.callback_query) await decideRegistration(payload.callback_query);
      return Response.json({ ok: true });
    }
    return Response.json(await sendAlerts(secret, payload.diagnostic === true));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Error en Telegram");
    return Response.json({ error: "No se pudo procesar el aviso de Telegram" }, { status: 502 });
  }
});
