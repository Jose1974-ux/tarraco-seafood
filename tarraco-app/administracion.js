(() => {
  const installUrl = 'https://tarraco-pedidos-portal.vercel.app/instalar.html';
  const qr = './tarraco-app/qr-instalacion';
  const pageSize = 25;
  let sending = false;
  let refreshMountedHistory;

  window.mountTarracoInvites = (panel, db) => {
    const root = panel.querySelector('[data-tarraco-invites]');
    root.className = 'tarraco-invite-panel';
    root.innerHTML = `
      <section class="card tarraco-invite-tools">
        <div>
          <h3>ENVIAR APLICACIÓN A CLIENTES</h3>
          <p>Comparte el enlace o el código QR. Ambos abren la página de instalación de TARRACO.</p>
          <div class="row">
            <button type="button" data-invite-copy>Copiar enlace</button>
            <button type="button" class="secondary" data-invite-share>Compartir QR</button>
            <button type="button" class="secondary" data-invite-print>Imprimir QR</button>
          </div>
          <div class="row">
            <a href="${qr}.png" download="TARRACO_QR_instalacion.png">Descargar PNG</a>
            <a href="${qr}.svg" download="TARRACO_QR_instalacion.svg">Descargar SVG para imprenta</a>
          </div>
          <p data-invite-share-status role="status" class="muted"></p>
        </div>
        <img src="${qr}.svg" width="124" height="124" alt="Código QR de instalación de TARRACO">
      </section>
      <section class="card">
        <h3>Enviar por correo electrónico</h3>
        <p data-invite-config role="status" class="muted">Comprobando el correo…</p>
        <p class="muted">Elige una o varias empresas, o envía la invitación a todas las empresas autorizadas y activas que tengan correo.</p>
        <div class="tarraco-recipients" data-invite-recipients role="group" aria-label="Clientes que pueden recibir la aplicación">Cargando empresas…</div>
        <div class="row">
          <button type="button" data-invite-send="selected" hidden disabled>Enviar a seleccionados</button>
          <button type="button" class="secondary" data-invite-send="all" hidden disabled>Enviar a todos</button>
          <a class="tarraco-install-button tarraco-compose-link" data-invite-compose target="_blank" rel="noopener noreferrer" aria-disabled="true">Abrir borrador en Gmail</a>
        </div>
        <p data-invite-progress role="status"></p>
      </section>
      <section class="card">
        <h3>Historial de envíos</h3>
        <p class="muted">«Enviado» significa que el proveedor aceptó el correo. El buzón del destinatario puede aplicar sus propios filtros.</p>
        <div data-invite-history role="region" aria-label="Resultados de los envíos" aria-live="polite">Cargando historial…</div>
        <div class="row">
          <button type="button" class="secondary" data-invite-page="previous" disabled>Anteriores</button>
          <button type="button" class="secondary" data-invite-page="next" disabled>Siguientes</button>
          <button type="button" class="secondary" data-invite-page="refresh">Actualizar historial</button>
        </div>
      </section>`;
    const find = selector => root.querySelector(selector);
    const recipients = find('[data-invite-recipients]');
    const progress = find('[data-invite-progress]');
    const shareStatus = find('[data-invite-share-status]');
    let configured = false;
    let companies = [];
    let offset = 0;
    let historyRequest = 0;

    function selected() {
      return Array.from(recipients.querySelectorAll('input:checked'), input => input.value);
    }

    function syncButtons() {
      const ids = new Set(selected());
      const addresses = companies.filter(company => ids.has(company.id)).map(company => company.email.trim());
      const compose = find('[data-invite-compose]');
      const url = new URL('https://mail.google.com/mail/');
      url.search = new URLSearchParams({
        view: 'cm',
        fs: '1',
        su: 'Instala TARRACO y accede a tus pedidos',
        body: 'Hola,\r\n\r\nInstala el portal de pedidos de TARRACO desde este enlace y sigue los pasos de tu dispositivo.\r\n' + installUrl + '\r\n\r\nUn saludo,\r\nTARRACO SEA FOOD 2002 SL',
        [addresses.length === 1 ? 'to' : 'bcc']: addresses.join(','),
      });
      const canCompose = addresses.length > 0 && url.href.length <= 2000;
      if (canCompose) compose.href = url.href;
      else compose.removeAttribute('href');
      compose.setAttribute('aria-disabled', String(!canCompose));
      if (addresses.length && !canCompose) progress.textContent = 'Selecciona menos empresas para abrir el borrador.';
      for (const mode of ['selected', 'all']) {
        const button = find('[data-invite-send="' + mode + '"]');
        button.hidden = !configured;
        button.disabled = !configured || sending || (mode === 'selected' ? !ids.size : !companies.length);
      }
    }

    async function invoke(body) {
      const { data, error } = await db.functions.invoke('tarraco-install-invite', { body });
      if (error) {
        const result = await error.context?.json?.().catch(() => null);
        throw new Error(result?.error || 'El servicio de correo aún no está disponible.');
      }
      return data;
    }

    async function loadCompanies() {
      const items = [];
      const size = 200;
      for (let start = 0; ; start += size) {
        const { data, error } = await db.from('companies').select('id,name,email').eq('active', true)
          .eq('registration_pending', false).not('email', 'is', null).order('id').range(start, start + size - 1);
        if (error) throw error;
        items.push(...data);
        if (data.length < size) break;
      }
      const seen = new Set();
      companies = items.sort((a, b) => a.name.localeCompare(b.name, 'es')).filter(company => {
        const email = company.email.trim().toLowerCase();
        if (seen.has(email) || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
        seen.add(email);
        return true;
      });
      recipients.replaceChildren(...companies.map(company => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = company.id;
        const name = document.createElement('span');
        name.textContent = company.name;
        const address = document.createElement('small');
        address.textContent = company.email;
        name.append(address);
        label.append(input, name);
        return label;
      }));
      if (!companies.length) recipients.textContent = 'No hay empresas con correo válido.';
      syncButtons();
    }

    async function loadHistory() {
      const request = ++historyRequest;
      const history = find('[data-invite-history]');
      const config = find('[data-invite-config]');
      try {
        const { configured: ready, rows } = await invoke({ action: 'status', offset });
        if (request !== historyRequest) return;
        configured = ready;
        config.textContent = ready ? 'Remitente disponible.' : 'Envío automático sin configurar. Selecciona los destinatarios y pulsa «Abrir borrador en Gmail».';
        find('[data-invite-page="previous"]').disabled = offset === 0;
        find('[data-invite-page="next"]').disabled = rows.length < pageSize;
        if (!rows.length) {
          history.textContent = 'No hay envíos en esta página.';
          return;
        }
        history.innerHTML = '<div class="tablewrap"><table><thead><tr><th>Fecha y hora</th><th>Empresa</th><th>Correo</th><th>Resultado</th></tr></thead><tbody></tbody></table></div>';
        const table = history.querySelector('tbody');
        const status = { sent: 'Enviado', failed: 'Fallido', unknown: 'Sin confirmar', processing: 'En curso' };
        const formatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' });
        for (const row of rows) {
          const line = table.insertRow();
          const result = [status[row.status], row.detail].filter(Boolean).join(' · ');
          for (const value of [formatter.format(new Date(row.requested_at)), row.company_name, row.recipient, result]) {
            line.insertCell().textContent = value;
          }
        }
      } catch (error) {
        if (request !== historyRequest) return;
        configured = false;
        config.textContent = error.message + ' Puedes usar «Abrir borrador en Gmail».';
        history.textContent = 'Historial temporalmente no disponible.';
      } finally {
        syncButtons();
      }
    }

    async function send(ids) {
      if (!configured || sending || !ids.length) return;
      if (!window.confirm('¿Enviar la invitación a ' + ids.length + (ids.length === 1 ? ' empresa?' : ' empresas?'))) return;
      const campaign = crypto.randomUUID();
      const total = { sent: 0, failed: 0, unknown: 0, skipped: 0 };
      sending = true;
      syncButtons();
      try {
        for (let index = 0; index < ids.length; index += 4) {
          progress.textContent = 'Procesando correos (' + index + ' de ' + ids.length + ')…';
          const result = await invoke({ action: 'send', companies: ids.slice(index, index + 4), campaign });
          for (const key of Object.keys(total)) total[key] += result[key];
        }
        progress.textContent = total.sent + ' enviados · ' + total.failed + ' fallidos · ' +
          total.unknown + ' sin confirmar · ' + total.skipped + ' omitidos.';
      } catch (error) {
        progress.textContent = error.message + ' Consulta el historial antes de volver a enviar.';
      } finally {
        sending = false;
        offset = 0;
        refreshMountedHistory?.();
      }
    }

    find('[data-invite-compose]').addEventListener('click', event => {
      if (event.currentTarget.hasAttribute('href')) {
        progress.textContent = 'Revisa el borrador y pulsa Enviar en Gmail.';
      }
    });

    recipients.addEventListener('change', syncButtons);
    find('[data-invite-send="selected"]').addEventListener('click', () => send(selected()));
    find('[data-invite-send="all"]').addEventListener('click', () => send(companies.map(company => company.id)));
    for (const button of root.querySelectorAll('[data-invite-page]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.invitePage;
        offset = action === 'refresh' ? 0 : Math.max(0, offset + (action === 'next' ? pageSize : -pageSize));
        loadHistory();
      });
    }
    refreshMountedHistory = () => {
      if (root.isConnected) {
        offset = 0;
        loadHistory();
      }
    };

    find('[data-invite-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(installUrl);
        shareStatus.textContent = 'Enlace copiado. Ya puedes pegarlo en WhatsApp o Telegram.';
      } catch {
        window.prompt('Copia el enlace de instalación.', installUrl);
      }
    });

    // Preload so sharing can use the same user gesture on Safari and Chrome.
    let qrFile;
    if (navigator.share) fetch(qr + '.png').then(response => {
      if (!response.ok) throw new Error();
      return response.blob();
    }).then(blob => {
      qrFile = new File([blob], 'TARRACO_QR_instalacion.png', { type: 'image/png' });
    }).catch(() => {});
    find('[data-invite-share]').addEventListener('click', async () => {
      if (!qrFile || !navigator.canShare?.({ files: [qrFile] })) {
        shareStatus.textContent = 'Descarga el PNG y adjúntalo en WhatsApp o Telegram.';
        return;
      }
      try {
        await navigator.share({ title: 'Instalar TARRACO', files: [qrFile] });
      } catch (error) {
        if (error.name !== 'AbortError') shareStatus.textContent = 'Descarga el PNG y adjúntalo en WhatsApp o Telegram.';
      }
    });

    find('[data-invite-print]').addEventListener('click', async () => {
      const print = document.createElement('section');
      print.className = 'tarraco-qr-print';
      print.innerHTML = `<h1>Instala TARRACO</h1><p>Escanea el código con la cámara de tu móvil.</p><img src="${qr}.svg" alt="Código QR de instalación"><p>${installUrl}</p>`;
      document.body.append(print);
      try {
        await print.querySelector('img').decode();
        document.body.classList.add('tarraco-printing');
        window.print();
      } catch {
        shareStatus.textContent = 'Descarga el SVG para imprimir el código QR.';
      } finally {
        document.body.classList.remove('tarraco-printing');
        print.remove();
      }
    });

    loadCompanies().catch(() => { recipients.textContent = 'No se pudo consultar la lista de empresas.'; });
    loadHistory();
  };
})();
