/* TARRACO: agrupación de compras por fecha de entrega.
   Módulo independiente: no modifica pedidos ni estados. */
(function (root) {
  'use strict';
  function aggregatePurchaseItems(orders, items, deliveryDate) {
    const eligible = new Map((orders || [])
      .filter(o => o.requested_date === deliveryDate && !['cancelled', 'rejected'].includes(o.status))
      .map(o => [o.id, o]));
    const totals = new Map();
    for (const item of items || []) {
      const order = eligible.get(item.order_id);
      if (!order) continue;
      const code = String(item.product_code_snapshot || '').trim();
      const name = String(item.product_name_snapshot || '').trim();
      const format = String(item.product_format_snapshot || '').trim();
      const unit = String(item.unit_snapshot || '').trim();
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      // No sumar kilos con cajas, piezas, sacos ni formatos diferentes.
      const key = JSON.stringify([code, name, format, unit]);
      if (!totals.has(key)) totals.set(key, { code, name, format, unit, quantity: 0, clients: {} });
      const row = totals.get(key);
      row.quantity += quantity;
      const client = String(order.company_id || '');
      row.clients[client] = (row.clients[client] || 0) + quantity;
    }
    return [...totals.values()].sort((a, b) =>
      a.code.localeCompare(b.code, 'es', { numeric: true }) ||
      a.name.localeCompare(b.name, 'es') ||
      a.format.localeCompare(b.format, 'es') ||
      a.unit.localeCompare(b.unit, 'es'));
  }
  root.TarracoPurchaseSummary = Object.freeze({ aggregatePurchaseItems });
})(typeof window !== 'undefined' ? window : globalThis);
