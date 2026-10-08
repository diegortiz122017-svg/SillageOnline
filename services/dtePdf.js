'use strict';

// Representación gráfica (PDF) de un Documento Tributario Electrónico.
//
// Se arma ÚNICAMENTE a partir del JSON del DTE que se transmitió al MH (más el
// sello y el QR de verificación) — nunca desde el pedido — para que el PDF no
// pueda diferir del documento legal: cada monto, línea y total se copia tal cual
// del JSON, sin recalcular nada. El documento con validez legal sigue siendo el
// JSON firmado; el PDF es la versión legible para el cliente.

const PDFDocument = require('pdfkit');

const GOLD = '#b8955a', INK = '#1a1714', MUTED = '#6b6258', LINE = '#d8cdb8', SOFT = '#faf8f4';
const L = 40, R = 572, W = R - L; // Carta (612×792), márgenes de 40

const TIPO = { '01': 'FACTURA', '03': 'COMPROBANTE DE CRÉDITO FISCAL', '05': 'NOTA DE CRÉDITO' };
// CAT-017 (forma de pago) — solo las que el sistema puede emitir + las comunes.
const FORMA_PAGO = {
  '01': 'Efectivo', '02': 'Tarjeta de débito', '03': 'Tarjeta de crédito', '04': 'Cheque',
  '05': 'Transferencia / depósito bancario', '08': 'Dinero electrónico', '11': 'Bitcoin', '99': 'Otros',
};
const CONDICION = { 1: 'Contado', 2: 'A crédito', 3: 'Otro' };

const money = n => '$' + (Number(n) || 0).toFixed(2);
const txt = v => (v == null ? '' : String(v));

function labelValue(doc, label, value, x, y, w) {
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.6 });
  const y2 = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(txt(value) || '—', x, y2, { width: w });
  return doc.y + 3;
}

// Bloque con título dorado y filas "Etiqueta: valor"
function partyBlock(doc, title, rows, x, y, w) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GOLD).text(title, x, y, { width: w, characterSpacing: 1.2 });
  doc.moveTo(x, doc.y + 2).lineTo(x + w, doc.y + 2).strokeColor(LINE).lineWidth(0.8).stroke();
  let cy = doc.y + 8;
  rows.filter(r => r[1] !== null && r[1] !== undefined && r[1] !== '').forEach(([k, v, bold]) => {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    const kw = 62;
    doc.text(k, x, cy, { width: kw });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK);
    doc.text(txt(v), x + kw, cy, { width: w - kw });
    cy = Math.max(doc.y, cy + 11) + 2;
  });
  return cy;
}

function render(doc, d) {
  const j = d.jsonDte || {};
  const ident = j.identificacion || {}, emisor = j.emisor || {}, rec = j.receptor || {};
  const items = j.cuerpoDocumento || [], r = j.resumen || {};
  const tipo = String(ident.tipoDte || '');
  const esFactura = tipo === '01';
  const pruebas = String(ident.ambiente) === '00';
  const contingencia = Number(ident.tipoOperacion) === 2;

  // ── Encabezado ──────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('SILLAGE', L, 36, { characterSpacing: 5 });
  doc.font('Helvetica').fontSize(8).fillColor(GOLD).text('PARFUMERIE', L, doc.y - 1, { characterSpacing: 4 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(TIPO[tipo] || 'DOCUMENTO TRIBUTARIO ELECTRÓNICO', 250, 38, { width: R - 250, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Documento Tributario Electrónico (DTE)', 250, doc.y + 1, { width: R - 250, align: 'right' });
  doc.moveTo(L, 84).lineTo(R, 84).strokeColor(GOLD).lineWidth(1.5).stroke();

  let y = 94;
  if (pruebas) {
    doc.rect(L, y, W, 18).fill('#fdf3d8');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9a7b2a')
      .text('AMBIENTE DE PRUEBAS — SIN VALIDEZ TRIBUTARIA', L, y + 5, { width: W, align: 'center', characterSpacing: 1 });
    y += 26;
  }

  // ── Identificación + QR ─────────────────────────────────────────────────────
  const qrSize = 96, colW = W - qrSize - 16;
  let cy = y;
  cy = labelValue(doc, 'Código de generación', d.codigoGeneracion || ident.codigoGeneracion, L, cy, colW);
  cy = labelValue(doc, 'Número de control', d.numeroControl || ident.numeroControl, L, cy, colW);
  cy = labelValue(doc, 'Sello de recepción', d.selloRecibido || (contingencia ? 'Pendiente (documento en contingencia)' : '—'), L, cy, colW);
  const half = (colW - 10) / 2;
  const yMeta = cy;
  labelValue(doc, 'Fecha y hora de generación', `${txt(ident.fecEmi)} ${txt(ident.horEmi)}`, L, yMeta, half);
  const y2 = labelValue(doc, 'Tipo de transmisión', contingencia ? 'Contingencia' : 'Normal', L + half + 10, yMeta, half);
  cy = Math.max(y2, doc.y);
  if (d.qrPng) doc.image(d.qrPng, R - qrSize, y - 2, { width: qrSize });
  y = Math.max(cy, y + qrSize) + 6;

  // ── Emisor / Receptor ───────────────────────────────────────────────────────
  const bw = (W - 20) / 2;
  const yEmisor = partyBlock(doc, 'EMISOR', [
    ['Nombre', emisor.nombre, true],
    ['Comercial', emisor.nombreComercial !== emisor.nombre ? emisor.nombreComercial : ''],
    ['NIT', emisor.nit], ['NRC', emisor.nrc],
    ['Actividad', emisor.descActividad],
    ['Dirección', emisor.direccion && emisor.direccion.complemento],
    ['Teléfono', emisor.telefono], ['Correo', emisor.correo],
  ], L, y, bw);
  const recDoc = rec.nit ? rec.nit : (rec.numDocumento || '');
  const yReceptor = partyBlock(doc, 'RECEPTOR', [
    ['Nombre', rec.nombre || 'Consumidor final', true],
    [rec.nit ? 'NIT' : 'Documento', recDoc], ['NRC', rec.nrc],
    ['Actividad', rec.descActividad],
    ['Dirección', rec.direccion && rec.direccion.complemento],
    ['Teléfono', rec.telefono], ['Correo', rec.correo],
  ], L + bw + 20, y, bw);
  y = Math.max(yEmisor, yReceptor) + 6;

  // ── Detalle ─────────────────────────────────────────────────────────────────
  const conDescuento = items.some(i => Number(i.montoDescu) > 0);
  const col = conDescuento
    ? { n: [L, 22], q: [L + 22, 38], d: [L + 66, 232], p: [L + 300, 70], g: [L + 372, 56], v: [L + 434, 98] }
    : { n: [L, 22], q: [L + 22, 38], d: [L + 66, 286], p: [L + 358, 80], g: null, v: [L + 442, 90] };
  const ventaLbl = esFactura ? 'VENTA (IVA INCL.)' : 'VENTA GRAVADA';

  function tableHeader(yy) {
    doc.rect(L, yy, W, 16).fill(INK);
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff');
    doc.text('#', col.n[0] + 4, yy + 5, { width: col.n[1] - 4 });
    doc.text('CANT.', col.q[0], yy + 5, { width: col.q[1], align: 'right' });
    doc.text('DESCRIPCIÓN', col.d[0] + 8, yy + 5, { width: col.d[1] });
    doc.text('PRECIO UNIT.', col.p[0], yy + 5, { width: col.p[1], align: 'right' });
    if (col.g) doc.text('DESCUENTO', col.g[0], yy + 5, { width: col.g[1], align: 'right' });
    doc.text(ventaLbl, col.v[0], yy + 5, { width: col.v[1] - 6, align: 'right' });
    return yy + 16;
  }
  y = tableHeader(y);
  items.forEach((it, idx) => {
    doc.font('Helvetica').fontSize(8.5);
    const h = Math.max(15, doc.heightOfString(txt(it.descripcion), { width: col.d[1] }) + 7);
    if (y + h > 690) { doc.addPage(); y = tableHeader(40); }
    if (idx % 2 === 0) doc.rect(L, y, W, h).fill(SOFT);
    doc.fillColor(INK).font('Helvetica').fontSize(8.5);
    doc.text(String(it.numItem || idx + 1), col.n[0] + 4, y + 4, { width: col.n[1] - 4 });
    doc.text(txt(it.cantidad), col.q[0], y + 4, { width: col.q[1], align: 'right' });
    doc.text(txt(it.descripcion), col.d[0] + 8, y + 4, { width: col.d[1] });
    doc.text(money(it.precioUni).replace(/(\.\d{2})0+$/, '$1'), col.p[0], y + 4, { width: col.p[1], align: 'right' });
    if (col.g) doc.text(money(it.montoDescu), col.g[0], y + 4, { width: col.g[1], align: 'right' });
    const venta = Number(it.ventaGravada || 0) + Number(it.ventaExenta || 0) + Number(it.ventaNoSuj || 0);
    doc.text(money(venta), col.v[0], y + 4, { width: col.v[1] - 6, align: 'right' });
    y += h;
  });
  doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.8).stroke();
  y += 10;

  // ── Totales (valores tal cual del JSON) ─────────────────────────────────────
  if (y > 560) { doc.addPage(); y = 40; }
  const yTot0 = y; // el bloque de letras/condición/pago va a la izquierda, a la altura de los totales
  const ivaTrib = (r.tributos || []).find(t => t.codigo === '20');
  const rows = [];
  rows.push([esFactura ? 'Suma de ventas' : 'Suma de ventas gravadas', r.subTotalVentas != null ? r.subTotalVentas : r.totalGravada]);
  if (Number(r.totalDescu) > 0) rows.push(['Descuentos', -Number(r.totalDescu)]);
  if (!esFactura) {
    rows.push(['Subtotal', r.subTotal]);
    if (ivaTrib) rows.push(['IVA 13%', ivaTrib.valor]);
  }
  const totalRow = esFactura ? ['TOTAL A PAGAR', r.totalPagar] : ['TOTAL A PAGAR', r.totalPagar != null ? r.totalPagar : r.montoTotalOperacion];
  const lx = 330, lw = 132, vx = 462, vw = R - 462;
  rows.forEach(([k, v]) => {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, lx, y, { width: lw, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text((v < 0 ? '-' : '') + money(Math.abs(v)), vx, y, { width: vw, align: 'right' });
    y += 14;
  });
  doc.moveTo(lx, y + 1).lineTo(R, y + 1).strokeColor(GOLD).lineWidth(1).stroke();
  y += 6;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(totalRow[0], lx - 30, y, { width: lw + 30, align: 'right' });
  doc.text(money(totalRow[1]), vx, y, { width: vw, align: 'right' });
  y += 20;
  if (esFactura && r.totalIva != null) {
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`IVA (13%) incluido en el total: ${money(r.totalIva)}`, lx - 30, y - 6, { width: lw + 30 + vw, align: 'right' });
    y += 12;
  }

  // ── Total en letras, condición y forma de pago ──────────────────────────────
  const pago = (r.pagos && r.pagos[0]) || {};
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('VALOR EN LETRAS', L, yTot0, { width: 280, characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(txt(r.totalLetras), L, doc.y + 1, { width: 280 });
  const yc = doc.y + 6;
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('CONDICIÓN DE LA OPERACIÓN', L, yc, { width: 280, characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(CONDICION[r.condicionOperacion] || '—', L, doc.y + 1, { width: 280 });
  const yp = doc.y + 6;
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('FORMA DE PAGO', L, yp, { width: 280, characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
    .text((FORMA_PAGO[pago.codigo] || (pago.codigo ? 'Código ' + pago.codigo : '—')) + (pago.referencia ? ' — ' + pago.referencia : ''), L, doc.y + 1, { width: 280 });
  y = Math.max(y, doc.y) + 14;

  // ── Pie ─────────────────────────────────────────────────────────────────────
  if (y > 700) { doc.addPage(); y = 40; }
  doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(0.8).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
    'Representación gráfica de un Documento Tributario Electrónico. El documento con validez legal es el archivo JSON firmado que acompaña este PDF. ' +
    'Verifica su autenticidad escaneando el código QR o en: ' + txt(d.verificacionUrl),
    L, y + 8, { width: W, lineGap: 2 });
  doc.font('Helvetica').fontSize(7.5).fillColor(GOLD).text('Sillage Parfumerie · sillage-sv.com', L, doc.y + 6, { width: W, align: 'center' });
}

// d: { jsonDte, codigoGeneracion, numeroControl, selloRecibido, verificacionUrl, qrPng (Buffer PNG, opcional) }
function buildDtePdf(d, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const j = d.jsonDte || {};
      const doc = new PDFDocument({
        size: 'LETTER', margin: L, compress: options.compress !== false,
        info: {
          Title: `${TIPO[(j.identificacion || {}).tipoDte] || 'DTE'} ${d.numeroControl || ''}`.trim(),
          Author: 'Sillage Parfumerie', Subject: 'Documento Tributario Electrónico',
        },
      });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      render(doc, d);
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildDtePdf };
