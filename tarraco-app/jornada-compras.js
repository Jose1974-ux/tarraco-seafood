/* TARRACO · reglas de jornada de compras (hora peninsular).
   No modifica la fecha de entrega ni el límite de pedidos del cliente. */
(function (root) {
  'use strict';
  const zone = 'Europe/Madrid';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function madridParts(date) {
    const result = {};
    for (const p of parts.formatToParts(date)) {
      if (p.type !== 'literal') result[p.type] = Number(p.value);
    }
    return result;
  }
  function businessDay(date) {
    const p = madridParts(date);
    // 00:00–00:29 pertenece a la jornada anterior.
    const iso = [p.year, String(p.month).padStart(2, '0'), String(p.day).padStart(2, '0')].join('-');
    if (p.hour !== 0 || p.minute >= 30) return iso;
    const prior = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
    return prior.toISOString().slice(0, 10);
  }
  function hasClosed(businessDate, now) {
    return businessDay(now) > businessDate;
  }
  root.TarracoPurchaseCycle = Object.freeze({ businessDay, hasClosed, madridParts });
})(typeof window !== 'undefined' ? window : globalThis);
