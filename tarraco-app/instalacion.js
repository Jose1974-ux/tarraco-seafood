(() => {
  // Use the same registration (including its URL parameters) as the existing
  // admin push client so installing never replaces a push subscription.
  const api = 'https://lmenenuazdqshfrwrwqy.supabase.co/functions/v1/tarraco-push';
  const display = matchMedia('(display-mode: standalone)');
  const installedKey = 'tarraco-installed';
  let prompt;
  let installedThisVisit = false;
  let busy = false;

  function rememberInstalled(installed) {
    try {
      if (installed) localStorage.setItem(installedKey, '1');
      else localStorage.removeItem(installedKey);
    } catch { /* Private browsing can disable storage. */ }
  }

  function isInstalled() {
    if (display.matches || navigator.standalone || installedThisVisit) return true;
    try { return localStorage.getItem(installedKey) === '1'; } catch { return false; }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    installedThisVisit = false;
    rememberInstalled(false);
    update();
  });

  window.addEventListener('appinstalled', () => {
    installedThisVisit = true;
    prompt = null;
    rememberInstalled(true);
    update();
  });

  function device() {
    const ua = navigator.userAgent;
    const platform = navigator.userAgentData?.platform || navigator.platform;
    if (/iPad/.test(ua) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1)) return 'ipad';
    if (/iPhone|iPod/.test(ua)) return 'iphone';
    if (/Android/.test(ua) || platform === 'Android') return 'android';
    if (/Win/.test(platform)) return 'windows';
    if (/Mac/.test(platform)) return 'mac';
    return 'other';
  }

  function update() {
    const installed = isInstalled();
    const banner = document.querySelector('.tarraco-login-install');
    const actions = document.getElementById('tarraco-install-actions');
    if (banner) banner.hidden = installed;
    if (!actions) return;
    actions.hidden = installed;
    const installButton = actions.querySelector('[data-tarraco-install]');
    const current = device();
    installButton.hidden = !prompt && (current === 'iphone' || current === 'ipad');
    document.getElementById('tarraco-install-status').textContent = installed
      ? 'TARRACO ya está instalada. Puedes abrirla desde su icono.' : '';
    document.getElementById('tarraco-steps').hidden = !!prompt;
  }

  function showInstructions() {
    const panel = document.getElementById('tarraco-steps');
    if (!panel) return;
    const current = device();
    const ua = navigator.userAgent;
    const embedded = /Instagram|FBAN|FBAV|WhatsApp|Telegram|\bwv\b|GSA\//i.test(ua);
    const appleMobile = current === 'ipad' || current === 'iphone';
    const safariMac = current === 'mac' && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
    const name = { ipad: 'iPad', iphone: 'iPhone', android: 'Android', windows: 'Windows', mac: 'Mac', other: 'tu dispositivo' }[current];
    let instructions;
    if (appleMobile) {
      instructions = [
        'En Safari, toca Compartir (□↑). Si no lo ves, abre el menú de la página.',
        'Elige «Añadir a pantalla de inicio».',
        'Si aparece «Abrir como app web», actívalo y toca «Añadir».',
      ];
    } else if (current === 'android') {
      instructions = ['En Chrome, toca el menú ⋮.', 'Elige «Instalar aplicación» o «Añadir a pantalla de inicio».', 'Confirma y busca el icono TARRACO.'];
    } else if (safariMac) {
      instructions = ['Abre el menú Archivo.', 'Elige «Añadir al Dock» y pulsa «Añadir».'];
    } else {
      instructions = ['En Chrome o Edge, busca el icono de instalación junto a la barra de direcciones.', 'También puedes abrir el menú ⋮ y buscar «Instalar página como aplicación» o «Aplicaciones».', 'Confirma y busca TARRACO entre tus aplicaciones.'];
    }
    const hint = document.getElementById('tarraco-browser-hint');
    hint.hidden = !embedded && !appleMobile;
    hint.textContent = embedded
      ? 'Abre este enlace en ' + (appleMobile ? 'Safari' : 'Chrome') + ' desde el menú del navegador integrado, o copia el enlace.'
      : 'En iPhone y iPad, instala TARRACO desde el menú Compartir de Safari.';
    document.getElementById('tarraco-copy-browser').hidden = hint.hidden;
    document.getElementById('tarraco-device').textContent = 'Instalación en ' + name;
    document.getElementById('tarraco-instructions').replaceChildren(...instructions.map(step => {
      const item = document.createElement('li');
      item.textContent = step;
      return item;
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (display.matches || navigator.standalone) rememberInstalled(true);
    showInstructions();
    update();
    display.addEventListener?.('change', update);
    document.addEventListener('click', async event => {
      const install = event.target.closest('[data-tarraco-install]');
      if (!install || isInstalled()) return;
      if (!prompt && install.tagName === 'A') return;
      event.preventDefault();
      if (busy) return;
      if (!prompt) {
        document.getElementById('tarraco-steps')?.focus();
        return;
      }
      const nativePrompt = prompt;
      prompt = null;
      busy = true;
      try {
        await nativePrompt.prompt();
        const choice = await nativePrompt.userChoice;
        if (choice.outcome === 'accepted') {
          installedThisVisit = true;
          rememberInstalled(true);
        }
      } catch {
        if (install.tagName === 'A') location.assign(install.href);
      } finally {
        busy = false;
        update();
        document.getElementById('tarraco-steps')?.focus();
      }
    });
    document.getElementById('tarraco-copy-browser')?.addEventListener('click', async () => {
      const url = new URL('./instalar.html', location.href).href;
      try {
        await navigator.clipboard.writeText(url);
        document.getElementById('tarraco-install-status').textContent = 'Enlace copiado. Pégalo en el navegador.';
      } catch {
        window.prompt('Copia este enlace y pégalo en el navegador.', url);
      }
    });

    if (isSecureContext && 'serviceWorker' in navigator) {
      const worker = new URL('./tarraco-push-sw.js', location.href);
      worker.searchParams.set('api', api);
      navigator.serviceWorker.register(worker, { scope: './' }).catch(error => {
        console.warn('No se pudo preparar la instalación de TARRACO.', error);
      });
    }
  });
})();
