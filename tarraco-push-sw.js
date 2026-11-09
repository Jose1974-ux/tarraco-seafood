/* TARRACO · Receptor de notificaciones push (fase cliente).
   El envío requiere suscripciones Web Push y servidor autenticado. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  const allowed = ['pedido','registro','mensaje','reparto'];
  if (!allowed.includes(data.type)) return;
  const title = 'TARRACO SEA FOOD · ' + ({pedido:'Nuevo pedido',registro:'Registro pendiente',mensaje:'Nuevo mensaje',reparto:'Incidencia de reparto'}[data.type]);
  const url = new URL('./', self.registration.scope);
  url.searchParams.set('aviso', data.type);
  if (data.id && /^[a-zA-Z0-9_-]{1,80}$/.test(String(data.id))) url.searchParams.set('aviso_id', String(data.id));
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || 'Abre administración para consultar el aviso').slice(0,180),
    tag: data.id ? 'tarraco-'+data.type+'-'+data.id : 'tarraco-'+data.type,
    icon: './a_wide_horizontal_marketing_banner_identical_to_t.png',
    data: { url: url.href },
    requireInteraction: true
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = event.notification.data?.url || new URL('./', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({type:'window',includeUncontrolled:true});
    const existing = windows.find(c => new URL(c.url).origin === new URL(destination).origin);
    if (existing) { await existing.focus(); await existing.navigate(destination); }
    else await clients.openWindow(destination);
  })());
});
