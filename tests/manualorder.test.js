'use strict';
// Pruebas de "marcar un DTE manual como pedido". Ejecutar:  node tests/manualorder.test.js
// Se generan DTE REALES con los constructores de services/dte.js y se comprueba que el pedido
// reconstruido coincide con lo que el admin capturó (ítems con IVA incluido y total).
const assert = require('assert');
// Los constructores del DTE son puros; solo el módulo de base de datos (driver de MySQL) no hace falta aquí.
const dbPath = require.resolve('../services/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { execute: async () => [[]], query: async () => [[]] } };
const dte = require('../services/dte');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }

const OPTS = { numeroControl: 'DTE-01-M001P001-000000000000001', codigoGeneracion: '11111111-2222-3333-4444-555555555555' };
const items = [
  { name: 'Lattafa Khamrah 100ml', qty: 2, price: 56.5 },
  { name: 'Decant Asad 10ml', qty: 1, price: 14.12 },
  { name: 'Envío', qty: 1, price: 5 },
];
const total = Math.round(items.reduce((s, i) => s + i.qty * i.price, 0) * 100) / 100;
const order = { id: 'MAN-1', customer: 'Ana Pérez', email: 'ana@x.com', phone: '77778888', payment_method: 'cod', items: JSON.stringify(items), total };
const rowOf = (tipo, json, extra) => ({ order_id: 'MAN-1', tipo_dte: tipo, json_dte: JSON.stringify(json), customer: 'Ana Pérez', email: 'ana@x.com', total, ...extra });

t('Factura (01): los ítems vuelven con el mismo precio (IVA incluido) y cantidad', () => {
  const o = dte.orderFromDteDoc(rowOf('01', dte.buildFactura(order, OPTS)));
  assert.deepStrictEqual(o.items.map(i => [i.name, i.qty, i.price]), items.map(i => [i.name, i.qty, i.price]));
  assert.strictEqual(o.total, total);
  assert.strictEqual(o.id, 'MAN-1');
});
t('CCF (03): el precio neto del DTE se convierte de vuelta a precio con IVA (sin perder centavos)', () => {
  const receptor = { nit: '06140812951023', nrc: '899100', nombre: 'Empresa S.A.', nombreComercial: 'Empresa', telefono: '25551234',
    complemento: 'Calle Real #5, San Salvador', departamento: '06', municipio: '14', distrito: '01', codActividad: '47722', descActividad: 'Venta', correo: 'e@x.com' };
  const json = dte.buildCreditoFiscal(order, receptor, OPTS);
  const o = dte.orderFromDteDoc(rowOf('03', json));
  assert.deepStrictEqual(o.items.map(i => [i.qty, i.price]), items.map(i => [i.qty, i.price]));
  assert.strictEqual(o.phone, '25551234');
  assert.ok(/Calle Real/.test(o.address), 'la dirección del receptor pasa al pedido: ' + o.address);
});
t('si la fila no trae total, lo toma del resumen del DTE', () => {
  const o = dte.orderFromDteDoc(rowOf('01', dte.buildFactura(order, OPTS), { total: null }));
  assert.strictEqual(o.total, total);
});
t('si la fila no trae nombre, usa el del receptor del propio DTE', () => {
  const o = dte.orderFromDteDoc(rowOf('01', dte.buildFactura(order, OPTS), { customer: null, email: null }));
  assert.strictEqual(o.customer, 'Ana Pérez');
});
t('sin nombre ni correo en ningún lado: "Consumidor Final" y correo vacío (quien inserta usa el del emisor)', () => {
  const json = { cuerpoDocumento: [{ descripcion: 'Algo', cantidad: 1, precioUni: 10 }] };
  const o = dte.orderFromDteDoc(rowOf('01', json, { customer: null, email: null }));
  assert.strictEqual(o.customer, 'Consumidor Final');
  assert.strictEqual(o.email, null);
});
t('un JSON ilegible no revienta: devuelve pedido sin ítems (el endpoint lo rechaza)', () => {
  const o = dte.orderFromDteDoc({ order_id: 'MAN-9', tipo_dte: '01', json_dte: '{no es json', total: 10 });
  assert.deepStrictEqual(o.items, []);
});

console.log(`\n${passed} pruebas pasaron`);
