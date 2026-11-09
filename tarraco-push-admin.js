/* The portal supplies its existing authenticated Supabase client. */
window.createTarracoPush = (db, api) => {
  const supported = isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let registration, context, enabled = false, sound = true;

  function unlock() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    context ||= new Audio();
    if (context.state !== 'running') context.resume().catch(() => {});
  }

  if (supported) navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'tarraco-push-sound' || !event.ports[0]) return;
    const play = enabled && sound && !document.hidden && context?.state === 'running';
    if (play) {
      for (let index = 0; index < 3; index++) {
        const start = context.currentTime + index * 0.24;
        const tone = context.createOscillator(), volume = context.createGain();
        tone.frequency.value = 920;
        volume.gain.setValueAtTime(0.09, start);
        volume.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
        tone.connect(volume).connect(context.destination);
        tone.start(start);
        tone.stop(start + 0.16);
      }
    }
    event.ports[0].postMessage(!!play);
  });

  async function request(body) {
    const { data, error } = await db.functions.invoke('tarraco-push', {
      body, signal: AbortSignal.timeout(8000),
    });
    if (error) {
      const result = await error.context?.json?.().catch(() => null);
      throw new Error(result?.error || 'No se pudo conectar con el servicio de avisos.');
    }
    return data;
  }

  async function subscription() {
    registration ||= await navigator.serviceWorker.getRegistration('./');
    if (!registration?.active?.scriptURL.includes('/tarraco-push-sw.js?')) return null;
    return registration.pushManager.getSubscription();
  }

  async function status() {
    if (!supported || Notification.permission !== 'granted') return;
    const sub = await subscription();
    if (sub) ({ enabled, sound } = await request({ action: 'status', endpoint: sub.endpoint }));
  }

  async function enable() {
    if (!supported) throw new Error('Abre el portal por HTTPS en Chrome para Android.');
    unlock();
    if (await Notification.requestPermission() !== 'granted') {
      throw new Error('Permite las notificaciones de esta web en los ajustes de Chrome.');
    }
    const { key } = await request({ action: 'key' });
    const script = new URL('./tarraco-push-sw.js', location.href);
    script.searchParams.set('api', api);
    registration = await navigator.serviceWorker.register(script, { scope: './' });
    await navigator.serviceWorker.ready;
    const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    let sub = await registration.pushManager.getSubscription();
    if (sub && String(new Uint8Array(sub.options.applicationServerKey)) !== String(bytes)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    try {
      await request({ action: 'subscribe', endpoint: sub.endpoint, ...sub.toJSON().keys, sound });
      enabled = true;
    } catch (error) {
      await sub.unsubscribe().catch(() => {});
      throw error;
    }
  }

  async function disable() {
    enabled = false;
    if (!supported) return;
    const sub = await subscription();
    try {
      if (sub) await request({ action: 'disable', endpoint: sub.endpoint });
    } finally {
      if (sub) await sub.unsubscribe();
      const notices = await registration?.getNotifications() || [];
      notices.forEach(notice => notice.close());
    }
  }

  async function deviceAction(action, fields = {}) {
    const sub = await subscription();
    if (!sub) throw new Error('Activa los avisos en este dispositivo.');
    return request({ action, endpoint: sub.endpoint, ...fields });
  }

  return {
    supported, unlock, status, enable, disable,
    get enabled() { return enabled; },
    get sound() { return sound; },
    async toggleSound() {
      if (!sound) unlock();
      await deviceAction('sound', { sound: !sound });
      sound = !sound;
    },
    test: () => deviceAction('test'),
    async read(kind, id) {
      if (supported && registration?.active) registration.active.postMessage({ type: 'tarraco-push-read', kind, id });
      await request({ action: 'read', kind, id });
    },
  };
};
