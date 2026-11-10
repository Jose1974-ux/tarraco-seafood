(() => {
  const headers = ['Código', 'Artículo / variedad', 'Formato', 'Precio base (€)', 'Base del precio', 'Cantidad', 'Unidad', 'Peso (kg)', 'Preparación', 'Observaciones del pedido'];
  const companyName = 'TARRACO SEA FOOD 2002 SL';
  const madridDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
  const number = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 12 });
  const showDate = day => day.split('-').reverse().join('/');
  let excelLibrary;

  async function readPages(query) {
    const rows = new Map();
    const limit = 200;
    for (let offset = 0; ; offset += limit) {
      const { data, error } = await query().order('id').range(offset, offset + limit - 1);
      if (error) throw error;
      for (const row of data) rows.set(row.id, row);
      if (data.length < limit) return [...rows.values()];
    }
  }

  async function readDay(db, day) {
    const orders = await readPages(() => db.from('orders')
      .select('id,company_id,created_at,customer_notes,admin_notes,driver_delivery_comment,companies(name)')
      .eq('requested_date', day).not('status', 'in', '(cancelled,rejected)'));

    const groups = new Map();
    const byOrder = new Map();
    orders.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const order of orders) {
      if (!groups.has(order.company_id)) {
        groups.set(order.company_id, { name: order.companies?.name || 'Empresa', orders: [], totals: new Map(), weight: null });
      }
      const group = groups.get(order.company_id);
      const notes = [
        order.customer_notes,
        order.admin_notes && 'Administración · ' + order.admin_notes,
        order.driver_delivery_comment && 'Reparto · ' + order.driver_delivery_comment
      ].filter(Boolean).join('\n');
      const entry = { ref: order.id.slice(0, 8).toUpperCase(), notes, rows: [], group };
      group.orders.push(entry);
      byOrder.set(order.id, entry);
    }

    const batch = 50;
    for (let start = 0; start < orders.length; start += batch) {
      const ids = orders.slice(start, start + batch).map(order => order.id);
      const items = await readPages(() => db.from('order_items')
        .select('id,order_id,product_name_snapshot,quantity,unit_snapshot,preparation_notes,product_code_snapshot,product_format_snapshot,unit_price_snapshot,price_unit_snapshot,products(product_code)')
        .in('order_id', ids));
      for (const item of items) {
        const order = byOrder.get(item.order_id);
        const unit = item.unit_snapshot;
        const quantity = Number(item.quantity);
        const weight = unit === 'kg' ? quantity : null;
        order.rows.push([orderArticleCode(item), item.product_name_snapshot, item.product_format_snapshot,
          item.unit_price_snapshot == null ? null : Number(item.unit_price_snapshot), item.price_unit_snapshot,
          quantity, unit, weight, item.preparation_notes]);
        order.group.totals.set(unit, (order.group.totals.get(unit) ?? 0) + quantity);
        if (weight !== null) order.group.weight = (order.group.weight ?? 0) + weight;
      }
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  function loadExcel() {
    if (!excelLibrary) {
      excelLibrary = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
        script.integrity = 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz';
        script.crossOrigin = 'anonymous';
        script.onload = () => resolve(window.ExcelJS);
        script.onerror = () => {
          script.remove();
          reject(new Error('No se pudo cargar la exportación a Excel. Comprueba la conexión y vuelve a intentarlo.'));
        };
        document.head.append(script);
      }).catch(error => { excelLibrary = null; throw error; });
    }
    return excelLibrary;
  }

  async function makeExcel(groups, day, unitName) {
    const ExcelJS = await loadExcel();
    const book = new ExcelJS.Workbook();
    const addSheet = (name, columns, widths) => {
      const sheet = book.addWorksheet(name, {
        views: [{ state: 'frozen', ySplit: 3 }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3' }
      });
      widths.forEach((width, i) => {
        const column = sheet.getColumn(i + 1);
        column.width = width;
        column.alignment = { vertical: 'top', wrapText: true };
      });
      sheet.mergeCells(1, 1, 1, columns.length);
      sheet.getCell('A1').value = companyName;
      sheet.getCell('A1').font = { bold: true, size: 15 };
      sheet.mergeCells(2, 1, 2, columns.length);
      sheet.getCell('A2').value = 'Fecha de entrega · ' + showDate(day);
      sheet.addRow(columns).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF133849' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      });
      return sheet;
    };
    const detail = addSheet('Pedidos', ['Cliente', 'Pedido', ...headers], [25, 11, 10, 30, 15, 12, 12, 11, 10, 11, 21, 24]);
    detail.getColumn(6).numFmt = '0.00';
    const totals = addSheet('Totales por cliente', ['Cliente', 'Unidad', 'Cantidad total', 'Peso total (kg)'], [38, 18, 18, 20]);
    groups.forEach((group, index) => {
      let first = true;
      for (const order of group.orders) {
        for (const row of order.rows.length ? order.rows : [['', 'Sin artículos registrados']]) {
          const [code, name, format, price, basis, quantity, unit, weight, prep] = row;
          detail.addRow([group.name, order.ref, code, name, format, price, basis ? unitName(basis) : null, quantity, unitName(unit), weight, prep, order.notes]).eachCell(cell => {
            if (index % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF5F6' } };
            if (first) cell.border = { top: { style: 'thin', color: { argb: 'FF176B87' } } };
          });
          first = false;
        }
      }
      for (const [unit, quantity] of group.totals) {
        totals.addRow([group.name, unitName(unit), quantity, unit === 'kg' ? group.weight : null]);
      }
    });
    detail.autoFilter = 'A3:L' + detail.rowCount;
    totals.autoFilter = 'A3:D' + totals.rowCount;
    return book.xlsx.writeBuffer();
  }

  window.mountTarracoDailyOrders = (root, { db, esc, unitNames, canRead }) => {
    if (!canRead()) return;
    const unitName = unit => unitNames[unit] || unit;
    const showTotal = ([unit, quantity]) => {
      const suffix = unitNames[unit] && unit !== 'kg' && quantity !== 1 ? 's' : '';
      return number.format(quantity) + ' ' + unitName(unit) + suffix;
    };
    root.innerHTML = `
      <form class="daily-order-controls">
        <label>Fecha de entrega<input type="date" required value="${madridDay.format(new Date())}"></label>
        <button type="submit">Actualizar listado</button>
        <button type="button" data-daily-excel disabled>Descargar Excel</button>
        <button type="button" data-daily-print disabled>Imprimir listado</button>
      </form>
      <p role="status" class="muted" data-daily-status></p>
      <div class="daily-order-document"></div>`;
    const form = root.querySelector('form');
    const dateField = form.querySelector('input');
    const status = root.querySelector('[data-daily-status]');
    const documentBody = root.querySelector('.daily-order-document');
    const excel = form.querySelector('[data-daily-excel]');
    const print = form.querySelector('[data-daily-print]');
    let generation = 0;
    const isActive = run => run === generation && root.isConnected && canRead();

    function showGroups(groups, day) {
      const cells = values => values.map((value, i) =>
        `<td><span class="daily-cell-label" aria-hidden="true">${headers[i]}</span>${esc(value ?? '—')}</td>`).join('');
      documentBody.innerHTML = `
        <header class="daily-order-heading"><strong>${companyName}</strong><h3>Listado diario de pedidos</h3>
          <p>Fecha de entrega · <time datetime="${esc(day)}">${showDate(day)}</time></p></header>
        ${groups.map(group => `<section class="daily-order-company">
          <h4>${esc(group.name)}</h4>
          ${group.orders.map(order => `<div class="daily-order-reference">
            <h5>Pedido ${esc(order.ref)}</h5>
            ${order.rows.length ? `<table><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>
              ${order.rows.map(([code, name, format, price, basis, quantity, unit, weight, prep]) => `<tr>${cells([code || '—', name, format, price === null ? null : number.format(price), basis ? unitName(basis) : null, number.format(quantity), unitName(unit), weight === null ? null : number.format(weight), prep || '—', order.notes || '—'])}</tr>`).join('')}
              </tbody></table>` : `<p>Sin artículos registrados</p><p>${esc(order.notes)}</p>`}</div>`).join('')}
          <p class="daily-order-totals"><strong>Totales por unidad</strong> ${[...group.totals].map(total => esc(showTotal(total))).join(' · ') || '—'}
          <br><strong>Peso total registrado</strong> ${group.weight === null ? '—' : number.format(group.weight) + ' kg'}</p>
        </section>`).join('')}`;
      documentBody.toggleAttribute('data-daily-ready', groups.length > 0);
    }

    async function refresh(action) {
      if (!canRead() || !dateField.reportValidity()) return;
      const run = ++generation;
      const day = dateField.value;
      excel.disabled = print.disabled = true;
      documentBody.removeAttribute('data-daily-ready');
      documentBody.replaceChildren();
      status.textContent = 'Cargando pedidos actualizados…';
      try {
        const groups = await readDay(db, day);
        if (!isActive(run)) return;
        showGroups(groups, day);
        status.textContent = groups.length ? '' : 'No hay pedidos para esta fecha de entrega.';
        if (groups.length && action === 'excel') {
          status.textContent = 'Preparando Excel…';
          const buffer = await makeExcel(groups, day, unitName);
          if (!isActive(run)) return;
          const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = 'pedidos-tarraco-' + day + '.xlsx';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          status.textContent = '';
        }
        if (groups.length && action === 'print') window.print();
      } catch (error) {
        if (isActive(run)) status.textContent = 'No se pudo completar el listado. ' + error.message;
      } finally {
        if (isActive(run)) excel.disabled = print.disabled = !documentBody.hasAttribute('data-daily-ready');
      }
    }
    form.addEventListener('submit', event => { event.preventDefault(); refresh(); });
    dateField.addEventListener('change', () => {
      if (dateField.value) {
        refresh();
      } else {
        generation++;
        excel.disabled = print.disabled = true;
        documentBody.removeAttribute('data-daily-ready');
        documentBody.replaceChildren();
        status.textContent = 'Selecciona una fecha de entrega.';
      }
    });
    excel.addEventListener('click', () => refresh('excel'));
    print.addEventListener('click', () => refresh('print'));
    refresh();
  };
})();
