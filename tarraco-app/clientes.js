(() => {
  const fields = [
    ['name', 'Razón social o nombre', { required: true }],
    ['trade_name', 'Nombre comercial'],
    ['customer_code', 'Código de cliente'],
    ['tax_id', 'NIF/CIF'],
    ['accounting_code', 'Código contable'],
    ['contact_name', 'Persona de contacto'],
    ['phone', 'Teléfono', { type: 'tel' }],
    ['email', 'Correo electrónico', { type: 'email' }],
    ['address', 'Dirección'],
    ['town', 'Población'],
    ['postal_code', 'Código postal'],
    ['province', 'Provincia']
  ];
  const pageSize = 30;
  const normalize = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const compact = text => normalize(text).replace(/[^a-z0-9]/g, '');
  let query = '';
  let page = 0;
  let showArchived = false;

  window.mountTarracoCustomers = (root, { db, esc, companies, refresh, formatDate, orderLabels }) => {
    const find = selector => root.querySelector(selector);
    root.innerHTML = `
      <section class="card">
        <h3>CLIENTES</h3>
        <div class="row">
          <button type="button" data-client-action="new">Crear cliente</button>
          <button type="button" class="secondary" data-client-action="reload">Actualizar</button>
        </div>
        <label for="clientSearch">Buscar por nombre, código, NIF/CIF o teléfono</label>
        <input id="clientSearch" type="search" autocomplete="off" value="${esc(query)}">
        <label><input data-client-archived type="checkbox" style="width:auto" ${showArchived ? 'checked' : ''}> Mostrar archivados</label>
        <details><summary>Crear cliente con acceso manual</summary><form id="customerForm"><label>Nombre de empresa/restaurante</label><input name="company_name" required><label>Persona de contacto</label><input name="contact_name"><label>Correo de acceso</label><input name="email" type="email" required><label>Contraseña inicial</label><input name="password" type="password" minlength="12" required><label>Teléfono</label><input name="phone"><label>Dirección</label><textarea name="address"></textarea><button style="margin-top:12px">Crear cliente y acceso</button></form></details>
        <p data-client-status role="status" aria-live="polite"></p>
        <div data-client-results></div>
        <div class="row">
          <button type="button" class="secondary" data-client-action="previous">Anterior</button>
          <button type="button" class="secondary" data-client-action="next">Siguiente</button>
        </div>
      </section>
      <div id="companyEdit"></div>
      <div data-client-detail></div>`;
    let accounts = new Set();
    const status = find('[data-client-status]');
    const detail = find('[data-client-detail]');
    const state = client => {
      if (client.archived_at) return 'Archivado';
      if (client.registration_pending) return 'Pendiente de autorización';
      if (client.registration_rejected_at) return 'Registro rechazado';
      if (!accounts.has(client.id)) return 'Sin registrar';
      return client.active ? 'Activo' : 'Bloqueado';
    };

    function list() {
      const search = normalize(query.trim());
      const code = compact(search);
      const rows = companies.filter(client => {
        if (client.archived_at && !showArchived) return false;
        if (!search) return true;
        const names = [client.name, client.trade_name].some(name => normalize(name).includes(search));
        return names || (code && [client.customer_code, client.tax_id, client.phone]
          .some(value => compact(value).includes(code)));
      });
      page = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
      const visible = rows.slice(page * pageSize, (page + 1) * pageSize);
      find('[data-client-results]').innerHTML = rows.length ? `
        <p class="muted">${rows.length} clientes · Página ${page + 1} de ${Math.ceil(rows.length / pageSize)}</p>
        <div class="tablewrap"><table>
          <thead><tr><th>Cliente</th><th>Código</th><th>Estado</th><th>Ficha</th></tr></thead>
          <tbody>${visible.map(client => `<tr>
            <td><strong>${esc(client.trade_name || client.name)}</strong>
              ${client.trade_name && client.trade_name !== client.name ? `<div>${esc(client.name)}</div>` : ''}</td>
            <td>${esc(client.customer_code || '—')}</td>
            <td>${state(client)}</td>
            <td><button type="button" class="secondary" data-client-action="edit" data-id="${esc(client.id)}">Abrir ficha</button></td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p>No hay clientes que coincidan.</p>';
      find('[data-client-action="previous"]').disabled = page === 0;
      find('[data-client-action="next"]').disabled = (page + 1) * pageSize >= rows.length;
    }

    function editor(client) {
      const hasAccount = accounts.has(client?.id);
      const loginActions = hasAccount && !client.registration_pending && !client.archived_at;
      detail.innerHTML = `<section class="card">
        <h3>${client ? esc(client.trade_name || client.name) : 'Crear cliente'}</h3>
        ${client ? `<p class="muted">${state(client)}</p>` : ''}
        <form data-client-form data-id="${esc(client?.id || '')}">
          <div class="split">${fields.map(([key, label, options = {}]) => `
            <label>${label}<input name="${key}" type="${options.type || 'text'}"
              maxlength="${key === 'address' ? 250 : 254}" value="${esc(client?.[key] || '')}"
              ${options.required ? 'required' : ''}
              ${key === 'email' && (hasAccount || client?.registration_pending) ? 'readonly' : ''}></label>
          `).join('')}</div>
          <div class="row"><button type="submit">Guardar</button>
          <button type="button" class="secondary" data-client-action="close">Cerrar ficha</button></div>
        </form>
        ${client ? `<div class="row">
          <button type="button" class="secondary" data-client-action="orders" data-id="${esc(client.id)}">Ver pedidos</button>
          ${loginActions && client.email ? `
            <button type="button" class="secondary" data-edit-company="${esc(client.id)}">Gestionar correo de acceso</button>
            <button type="button" class="secondary" data-reset-company-password="${esc(client.id)}">Restablecer contraseña</button>` : ''}
          ${loginActions && !client.registration_rejected_at ? `<button type="button" class="secondary"
            data-client-action="toggle" data-id="${esc(client.id)}">${client.active ? 'Bloquear' : 'Reactivar'}</button>` : ''}
          ${!client.archived_at && !client.registration_pending ? `<button type="button" class="danger"
            data-client-action="archive" data-id="${esc(client.id)}">Eliminar</button>` : ''}
          ${client.archived_at ? `<button type="button" class="secondary"
            data-client-action="restore" data-id="${esc(client.id)}">Recuperar ficha</button>` : ''}
        </div><div data-client-orders></div>` : ''}
      </section>`;
      detail.scrollIntoView({ block: 'nearest' });
    }

    async function update(client, patch) {
      const request = client ? db.from('companies').update(patch).eq('id', client.id) :
        db.from('companies').insert({ ...patch, active: false });
      const { data, error } = await request.select('id').single();
      if (error) throw error;
      if (!data?.id) throw Error('El servidor no confirmó el cambio.');
      await refresh();
      const next = document.querySelector('[data-tarraco-customers] [data-client-status]');
      if (next) next.textContent = 'Cambios guardados.';
    }

    async function showOrders(client, offset = 0) {
      const target = find('[data-client-orders]');
      target.textContent = 'Cargando pedidos…';
      const { data, error } = await db.from('orders')
        .select('id,created_at,requested_date,status,archived_by_admin')
        .eq('company_id', client.id).order('created_at', { ascending: false }).order('id')
        .range(offset, offset + pageSize);
      if (error) throw error;
      target.innerHTML = data.length ? `<h4>Pedidos de ${esc(client.trade_name || client.name)}</h4>
        <div class="tablewrap"><table><thead><tr><th>Referencia</th><th>Fecha del pedido</th><th>Entrega</th><th>Estado</th></tr></thead>
        <tbody>${data.slice(0, pageSize).map(order => `<tr>
          <td>${esc(order.id.slice(0, 8).toUpperCase())}</td><td>${esc(formatDate(order.created_at))}</td>
          <td>${esc(order.requested_date || '—')}</td>
          <td>${esc(orderLabels[order.status] || order.status)}${order.archived_by_admin ? ' · Archivado' : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p>Este cliente todavía no tiene pedidos.</p>';
      for (const [available, next, label] of [
        [offset > 0, offset - pageSize, 'Pedidos anteriores'],
        [data.length > pageSize, offset + pageSize, 'Más pedidos']
      ]) {
        if (!available) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = 'secondary';
        button.addEventListener('click', () => showOrders(client, next).catch(displayError));
        target.append(button);
      }
    }

    function displayError(error) {
      status.textContent = error.code === '23505'
        ? 'Ese código ya pertenece a otro cliente.'
        : 'No se pudo completar la operación. ' + error.message;
    }

    find('#clientSearch').addEventListener('input', event => {
      query = event.target.value;
      page = 0;
      list();
    });
    find('[data-client-archived]').addEventListener('change', event => {
      showArchived = event.target.checked;
      page = 0;
      list();
    });
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-client-action]');
      if (!button) return;
      const client = companies.find(row => row.id === button.dataset.id);
      button.disabled = true;
      status.textContent = '';
      try {
        switch (button.dataset.clientAction) {
          case 'new': editor(); break;
          case 'edit': editor(client); break;
          case 'close': detail.replaceChildren(); find('#companyEdit').replaceChildren(); break;
          case 'reload': await refresh(); break;
          case 'previous': page -= 1; list(); return;
          case 'next': page += 1; list(); return;
          case 'orders': await showOrders(client); break;
          case 'toggle': await update(client, { active: !client.active }); break;
          case 'archive':
            if (confirm('¿Eliminar este cliente de la lista activa? Se conservarán su ficha y todos sus pedidos.')) {
              await update(client, { active: false, archived_at: new Date().toISOString() });
            }
            break;
          case 'restore': await update(client, { active: false, archived_at: null }); break;
        }
      } catch (error) {
        displayError(error);
      } finally {
        if (!['previous', 'next'].includes(button.dataset.clientAction)) button.disabled = false;
      }
    });
    root.addEventListener('submit', async event => {
      const form = event.target;
      if (!form.matches('[data-client-form]')) return;
      event.preventDefault();
      event.stopPropagation();
      const client = companies.find(row => row.id === form.dataset.id);
      const input = new FormData(form);
      const patch = Object.fromEntries(fields.filter(([key]) =>
        key !== 'email' || !(accounts.has(client?.id) || client?.registration_pending)
      ).map(([key]) => [key, input.get(key).trim() || null]));
      if (!patch.name) {
        status.textContent = 'Escribe la razón social o el nombre del cliente.';
        return;
      }
      if (!patch.customer_code && !client?.customer_code) patch.customer_code = 'WEB-' + crypto.randomUUID().toUpperCase();
      const save = form.querySelector('[type="submit"]');
      save.disabled = true;
      try {
        await update(client, patch);
      } catch (error) {
        displayError(error);
      } finally {
        save.disabled = false;
      }
    });

    status.textContent = 'Cargando clientes…';
    async function loadAccounts() {
      const ids = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db.rpc('tarraco_customer_accounts')
          .order('company_id').range(offset, offset + 499);
        if (error) throw error;
        ids.push(...data.map(row => row.company_id));
        if (data.length < 500) break;
      }
      accounts = new Set(ids);
      status.textContent = '';
      list();
    }
    loadAccounts().catch(displayError);
  };
})();
