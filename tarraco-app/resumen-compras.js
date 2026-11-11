/* TARRACO: resumen de compras en administración; no altera el listado existente. */
(() => {
  const previous = window.mountTarracoDailyOrders;
  if (typeof previous !== 'function' || !window.TarracoPurchaseSummary) return;
  window.mountTarracoDailyOrders = (root, context) => {
    previous(root, context);
    if (!context.canRead()) return;
    const section = document.createElement('section');
    section.className = 'card';
    section.innerHTML = '<h3>Resumen general de compras</h3><p>Totales por artículo, variedad, formato y unidad para la fecha de entrega seleccionada.</p><button type="button" data-purchase-refresh>Actualizar resumen</button> <button type="button" data-purchase-export disabled>Descargar CSV</button><p data-purchase-status role="status"></p><div data-purchase-table></div>';
    root.append(section);
    const dateInput = root.querySelector('.daily-order-controls input[type=date]');
    const status = section.querySelector('[data-purchase-status]');
    const table = section.querySelector('[data-purchase-table]');
    const exportButton = section.querySelector('[data-purchase-export]');
    let rows = [];
    let generation = 0;
    const escape = context.esc;
    async function all(query) {
      const result = [];
      for (let from = 0; ; from += 200) {
        const { data, error } = await query().range(from, from + 199);
        if (error) throw error;
        result.push(...data);
        if (data.length < 200) return result;
      }
    }
    async function refresh() {
      const run = ++generation;
      rows = [];
      exportButton.disabled = true;
      table.replaceChildren();
      if (!context.canRead() || !dateInput?.value) return;
      const day = dateInput.value;
      status.textContent = 'Calculando cantidades…';
      try {
        const orders = await all(() => context.db.from('orders')
          .select('id,company_id,requested_date,status').eq('requested_date', day).order('id'));
        const items = [];
        for (let i = 0; i < orders.length; i += 40) {
          const ids = orders.slice(i, i + 40).map(o => o.id);
          items.push(...await all(() => context.db.from('order_items')
            .select('order_id,product_code_snapshot,product_name_snapshot,product_format_snapshot,unit_snapshot,quantity')
            .in('order_id', ids).order('id')));
        }
        if (run !== generation || !context.canRead() || !root.isConnected) return;
        rows = window.TarracoPurchaseSummary.aggregatePurchaseItems(orders, items, day);
        table.innerHTML = rows.length
          ? '<div style="overflow-x:auto"><table><thead><tr><th>Código</th><th>Artículo / variedad</th><th>Formato</th><th>Cantidad total</th><th>Unidad</th></tr></thead><tbody>' +
            rows.map(r => '<tr><td>'+escape(r.code)+'</td><td>'+escape(r.name)+'</td><td>'+escape(r.format)+'</td><td>'+escape(String(r.quantity))+'</td><td>'+escape(r.unit)+'</td></tr>').join('') + '</tbody></table></div>'
          : '<p>No hay artículos para esta fecha de entrega.</p>';
        exportButton.disabled = !rows.length;
        status.textContent = 'Resumen actualizado. Datos actuales, todavía sin cierre histórico automático.';
      } catch (error) {
        if (run === generation) status.textContent = 'No se pudo calcular el resumen: ' + error.message;
      }
    }
    section.querySelector('[data-purchase-refresh]').addEventListener('click', refresh);
    dateInput?.addEventListener('change', refresh);
    exportButton.addEventListener('click', () => {
      if (!context.canRead() || !rows.length) return;
      const csv = [['Código','Artículo / variedad','Formato','Cantidad','Unidad'], ...rows.map(r => [r.code,r.name,r.format,r.quantity,r.unit])]
        .map(line => line.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'resumen-compras-' + dateInput.value + '.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    refresh();
  };
})();
