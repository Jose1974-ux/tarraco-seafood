const titles = {
  pedido: 'Nuevo pedido',
  registro: 'Registro pendiente',
  mensaje: 'Nuevo mensaje',
  reparto: 'Incidencia de reparto',
  prueba: 'Aviso de prueba',
};
const isId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const scope = new URL(self.registration.scope);
const api = new URL(self.location.href).searchParams.get('api');
let handling = Promise.resolve();

function serial(event, task) {
  handling = handling.catch(() => {}).then(task);
  event.waitUntil(handling);
}

function store(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tarraco-push', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('delivery');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('delivery', mode);
      const request = action(tx.objectStore('delivery'));
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

async function acknowledge(delivery) {
  if (!api || !isId(delivery)) return false;
  try {
    const response = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open', delivery }),
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function askForSound(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = played => { clearTimeout(timer); channel.port1.close(); resolve(played); };
    const timer = setTimeout(() => finish(false), 400);
    channel.port1.onmessage = event => finish(event.data === true);
    client.postMessage({ type: 'tarraco-push-sound' }, [channel.port2]);
  });
}

self.addEventListener('push', event => serial(event, async () => {
  let data;
  try { data = event.data?.json(); } catch { return; }
  if (!Object.hasOwn(titles, data?.type) || !isId(data.id) || !isId(data.delivery) ||
      !Number.isInteger(data.round) || data.round < 0) return;
  const tag = 'tarraco-' + data.delivery;
  const previous = await store('readonly', s => s.get(data.delivery)).catch(() => null);
  if (previous?.opened) {
    if (previous.pending && await acknowledge(data.delivery)) {
      await store('readwrite', s => s.put({ opened: true }, data.delivery)).catch(() => {});
    }
    return;
  }
  if (previous?.round >= data.round) return;

  const destination = new URL('./', scope);
  destination.searchParams.set('aviso', data.type);
  destination.searchParams.set('aviso_id', data.id);
  if (isId(data.company)) destination.searchParams.set('aviso_empresa', data.company);

  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.find(c => c.visibilityState === 'visible' && c.focused && c.url.startsWith(scope.href));
  const played = data.sound === true && visible ? await askForSound(visible).catch(() => false) : false;
  const silent = data.sound !== true || played;
  await self.registration.showNotification('TARRACO SEA FOOD · ' + titles[data.type], {
    body: data.type === 'prueba' ? 'Toca este aviso para detener su recordatorio.' : 'Abre administración para consultar el aviso.',
    tag,
    icon: new URL('a_wide_horizontal_marketing_banner_identical_to_t.png', scope).href,
    silent,
    ...(silent ? {} : { vibrate: [170, 170, 170, 170, 170] }),
    renotify: data.round > 0,
    requireInteraction: true,
    data: { destination: destination.href, delivery: data.delivery, type: data.type, id: data.id },
  });
  await store('readwrite', s => s.put({ round: data.round }, data.delivery)).catch(() => {});
}));

self.addEventListener('notificationclick', event => {
  const notification = event.notification;
  notification.close();
  serial(event, async () => {
    const data = notification.data;
    if (!isId(data?.delivery)) return;
    await store('readwrite', s => s.put({ opened: true, pending: true }, data.delivery)).catch(() => {});
    const opened = acknowledge(data.delivery).then(ok => {
      if (ok) return store('readwrite', s => s.put({ opened: true }, data.delivery)).catch(() => {});
    });
    const destination = new URL(data.destination, scope);
    if (!destination.href.startsWith(scope.href)) return;
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(c => c.url.startsWith(scope.href));
    const navigation = existing ? existing.navigate(destination.href).then(c => c?.focus()) : clients.openWindow(destination.href);
    await Promise.allSettled([opened, navigation]);
  });
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'tarraco-push-read' || !isId(event.data.id) || !Object.hasOwn(titles, event.data.kind)) return;
  serial(event, async () => {
    const notifications = await self.registration.getNotifications();
    for (const notification of notifications) {
      const data = notification.data;
      if (data?.type !== event.data.kind || data?.id !== event.data.id || !isId(data.delivery)) continue;
      notification.close();
      await store('readwrite', s => s.put({ opened: true }, data.delivery)).catch(() => {});
    }
  });
});
