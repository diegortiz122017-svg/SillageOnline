'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  DTE — Documento Tributario Electrónico (Factura Electrónica El Salvador)
// ────────────────────────────────────────────────────────────────────────────
//  Builds the official MH JSON, signs it through Hacienda's firmador service,
//  transmits it to the reception API and persists the Sello de Recepción.
//
//  Supported document types:
//    01 — Factura (Consumidor Final)   schema version 1   IVA incluido en precio
//    03 — Comprobante de Crédito Fiscal schema version 3   IVA desglosado
//    05 — Nota de Crédito              schema version 3   ajuste sobre un CCF
//
//  IMPORTANT — before going live:
//    • Validate the produced JSON against the official MH JSON Schemas
//      (factura.gob.sv → "Documentos técnicos"). Field names/types are exact.
//    • Fill the real emisor data (NIT, NRC, codActividad, departamento,
//      municipio…) via the DTE_* environment variables.
//    • Everything here is gated by cfg.DTE_ENABLED — when false this module
//      never touches the network and emitForOrder() is a no-op.
// ════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const db     = require('./db');
const cfg    = require('../config');

const IVA_RATE = 0.13;

// ─── small helpers ────────────────────────────────────────────────────────────
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round8 = n => Math.round((Number(n) + Number.EPSILON) * 1e8) / 1e8;

function uuidUpper() {
  return crypto.randomUUID().toUpperCase();
}

// MH expects fecEmi = YYYY-MM-DD and horEmi = HH:MM:SS in El Salvador time (UTC-6).
function nowSV() {
  const d = new Date(Date.now() - 6 * 60 * 60 * 1000); // shift to UTC-6
  const fecEmi = d.toISOString().slice(0, 10);
  const horEmi = d.toISOString().slice(11, 19);
  return { fecEmi, horEmi };
}

// Número de control (31 chars). Formato exacto del esquema MH:
//   DTE-{tipo}-(M|B|S|P)###P###-{15 dígitos}     ej. DTE-01-M001P001-000000000000123
function numeroControl(tipoDte, correlativo) {
  const e   = cfg.DTE_EMISOR;
  const est = String(e.codEstable || 'M001').toUpperCase();       // letra + 3 dígitos
  const pv  = String(e.codPuntoVenta || '001').replace(/\D/g, '').padStart(3, '0').slice(-3);
  const seq = String(correlativo).padStart(15, '0');
  return `DTE-${tipoDte}-${est}P${pv}-${seq}`;
}

// ─── número a letras (formato MH: "CIEN 00/100") ──────────────────────────────
function numeroALetras(num) {
  const entero   = Math.floor(num);
  const centavos = Math.round((num - entero) * 100);
  const UNI = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
    'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE',
    'DIECIOCHO', 'DIECINUEVE', 'VEINTE'];
  const DEC = ['', '', 'VEINTI', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const CEN = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
    'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function seccion(n) {
    if (n === 0)   return '';
    if (n === 100) return 'CIEN';
    let out = '';
    const c = Math.floor(n / 100);
    const d = Math.floor((n % 100) / 10);
    const u = n % 10;
    if (c) out += CEN[c] + ' ';
    const dd = n % 100;
    if (dd <= 20) {
      out += UNI[dd];
    } else if (d === 2) {
      out += 'VEINTI' + UNI[u];
    } else {
      out += DEC[d];
      if (u) out += ' Y ' + UNI[u];
    }
    return out.trim();
  }

  function aLetras(n) {
    if (n === 0) return 'CERO';
    let out = '';
    const millones = Math.floor(n / 1e6);
    const miles    = Math.floor((n % 1e6) / 1000);
    const resto    = n % 1000;
    if (millones) out += (millones === 1 ? 'UN MILLÓN' : seccion(millones) + ' MILLONES') + ' ';
    if (miles)    out += (miles === 1 ? 'MIL' : seccion(miles) + ' MIL') + ' ';
    if (resto)    out += seccion(resto);
    return out.trim();
  }

  const cc = String(centavos).padStart(2, '0');
  return `${aLetras(entero)} ${cc}/100`;
}

// ─── emisor block (shared — coincide con esquema FC v2 / CCF v4 / NC v4) ───────
function buildEmisor() {
  const e = cfg.DTE_EMISOR;
  return {
    nit:             e.nit,
    nrc:             e.nrc,
    nombre:          e.nombre,
    codActividad:    e.codActividad,
    descActividad:   e.descActividad,
    nombreComercial: e.nombreComercial || e.nombre,
    direccion: {
      departamento: e.departamento,
      municipio:    e.municipio,
      distrito:     e.distrito,
      complemento:  e.complemento,
    },
    telefono:      e.telefono,
    correo:        e.correo,
    codEstable:    e.codEstable,
    codPuntoVenta: e.codPuntoVenta,
  };
}

// Forma de pago (CAT-017) a partir del método de pago del pedido.
//   01 = Billetes y monedas · 02 = Tarjeta Débito · 03 = Tarjeta Crédito
//   05 = Transferencia/Depósito · 99 = Otros (requiere referencia)
function formaPagoDesde(order) {
  const m = String(order.payment_method || order.paymentMethod || '').toLowerCase();
  if (m.includes('wompi') || m.includes('card') || m.includes('tarjeta') || m.includes('credit')) {
    return { codigo: '02', referencia: null };
  }
  if (m.includes('btc') || m.includes('bitcoin') || m.includes('crypto') || m.includes('lightning')) {
    return { codigo: '99', referencia: 'Bitcoin / Lightning' };
  }
  // efectivo / contra entrega (COD) / desconocido
  return { codigo: '01', referencia: null };
}

// Normalise a stored order's items array into a consistent shape.
//   { descripcion, cantidad, precioUnitario }  (precio = lo que pagó el cliente, IVA incluido)
function normalizeItems(items) {
  return (items || []).map(i => ({
    descripcion:    String(i.name || i.descripcion || 'Producto').slice(0, 1000),
    cantidad:       Number(i.qty || i.cantidad || 1),
    precioUnitario: round2(Number(i.price || i.precioUni || 0)),
  }));
}

// ════════════════════════════════════════════════════════════════════════════
//  TIPO 01 — Factura Consumidor Final (IVA incluido en el precio)
// ════════════════════════════════════════════════════════════════════════════
function buildFactura(order, opts) {
  const { fecEmi, horEmi } = nowSV();
  const items = normalizeItems(JSON.parse(order.items || '[]'));

  const cuerpoDocumento = items.map((it, idx) => {
    const ventaGravada = round2(it.cantidad * it.precioUnitario); // IVA incluido
    const ivaItem      = round2(ventaGravada - ventaGravada / (1 + IVA_RATE));
    return {
      numItem:        idx + 1,
      tipoItem:       1,            // 1 = bien
      numeroDocumento: null,
      cantidad:       it.cantidad,
      codigo:         null,
      codTributo:     null,
      uniMedida:      59,           // 59 = unidad
      descripcion:    it.descripcion,
      precioUni:      it.precioUnitario,
      montoDescu:     0,
      ventaNoSuj:     0,
      ventaExenta:    0,
      ventaGravada,
      tributos:       null,         // FC: IVA incluido, sin tributos a nivel ítem
      psv:            0,
      noGravado:      0,
      ivaItem,
    };
  });

  const totalGravada = round2(cuerpoDocumento.reduce((s, c) => s + c.ventaGravada, 0));
  const totalIva     = round2(cuerpoDocumento.reduce((s, c) => s + c.ivaItem, 0));

  const resumen = {
    totalNoSuj:           0,
    totalExenta:          0,
    totalGravada:         totalGravada,
    subTotalVentas:       totalGravada,
    descuNoSuj:           0,
    descuExenta:          0,
    descuGravada:         0,
    porcentajeDescuento:  0,
    totalDescu:           0,
    tributos:             null,        // FC: null (IVA incluido vía totalIva)
    subTotal:             totalGravada,
    ivaRete:              0,
    montoTotalOperacion:  totalGravada,
    totalNoGravado:       0,
    totalPagar:           totalGravada,
    totalLetras:          numeroALetras(totalGravada),
    totalIva:             totalIva,    // FC: IVA embebido informativo
    saldoFavor:           0,
    condicionOperacion:   1,           // 1 = contado
    pagos:                (function(){
      const fp = formaPagoDesde(order);
      return [{
        codigo:     fp.codigo,
        montoPago:  totalGravada,
        referencia: fp.referencia,
        plazo:      null,
        periodo:    null,
      }];
    })(),
    numPagoElectronico:   null,
    observaciones:        null,
  };

  return {
    identificacion:      buildIdentificacion('01', 2, opts.numeroControl, opts.codigoGeneracion, fecEmi, horEmi),
    documentoRelacionado: null,
    emisor:              buildEmisor(),
    receptor: {
      tipoDocumento: null,
      numDocumento:  null,
      nrc:           null,
      nombre:        order.customer || null,
      codActividad:  null,
      descActividad: null,
      direccion:     null,
      telefono:      null,            // se omite (esquema exige 8+ chars si no es null)
      correo:        order.email || null,
    },
    otrosDocumentos: null,
    ventaTercero:    null,
    cuerpoDocumento,
    resumen,
    apendice:        null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  TIPO 03 — Comprobante de Crédito Fiscal (IVA desglosado, receptor obligatorio)
//  receptor = { nit, nrc, nombre, codActividad, descActividad, depto, municipio,
//               complemento, telefono, correo }
// ════════════════════════════════════════════════════════════════════════════
function buildCreditoFiscal(order, receptor, opts) {
  const { fecEmi, horEmi } = nowSV();
  const items = normalizeItems(JSON.parse(order.items || '[]'));

  const cuerpoDocumento = items.map((it, idx) => {
    // El precio guardado incluye IVA → lo convertimos a neto para el CCF.
    const precioNeto   = round8(it.precioUnitario / (1 + IVA_RATE));
    const ventaGravada = round2(it.cantidad * precioNeto);
    return {
      numItem:         idx + 1,
      tipoItem:        1,
      numeroDocumento: null,
      codigo:          null,
      codTributo:      null,
      descripcion:     it.descripcion,
      cantidad:        it.cantidad,
      uniMedida:       59,
      precioUni:       precioNeto,
      montoDescu:      0,
      ventaNoSuj:      0,
      ventaExenta:     0,
      ventaGravada,
      tributos:        ['20'],   // 20 = IVA 13%
      psv:             0,
      noGravado:       0,
    };
  });

  const totalGravada = round2(cuerpoDocumento.reduce((s, c) => s + c.ventaGravada, 0));
  const iva          = round2(totalGravada * IVA_RATE);
  const montoTotal   = round2(totalGravada + iva);

  const resumen = {
    totalNoSuj:          0,
    totalExenta:         0,
    totalGravada:        totalGravada,
    subTotalVentas:      totalGravada,
    descuNoSuj:          0,
    descuExenta:         0,
    descuGravada:        0,
    porcentajeDescuento: 0,
    totalDescu:          0,
    tributos: [
      { codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: iva },
    ],
    subTotal:            totalGravada,
    ivaPerci:            0,
    ivaRete:             0,
    montoTotalOperacion: montoTotal,
    totalNoGravado:      0,
    totalPagar:          montoTotal,
    totalLetras:         numeroALetras(montoTotal),
    saldoFavor:          0,
    condicionOperacion:  1,
    pagos:               (function(){
      const fp = formaPagoDesde(order);
      return [{ codigo: fp.codigo, montoPago: montoTotal, referencia: fp.referencia, plazo: null, periodo: null }];
    })(),
    numPagoElectronico:  null,
    observaciones:       null,
  };

  return {
    identificacion:      buildIdentificacion('03', 4, opts.numeroControl, opts.codigoGeneracion, fecEmi, horEmi),
    documentoRelacionado: null,
    emisor:              buildEmisor(),
    receptor:            buildReceptorCCF(receptor, order),
    otrosDocumentos:     null,
    ventaTercero:        null,
    cuerpoDocumento,
    resumen,
    apendice:            null,
  };
}

// Receptor obligatorio de CCF/NC (esquema v4).
function buildReceptorCCF(receptor, order) {
  return {
    nit:             receptor.nit,
    nrc:             receptor.nrc || null,
    nombre:          receptor.nombre,
    codActividad:    receptor.codActividad,
    descActividad:   receptor.descActividad,
    nombreComercial: receptor.nombreComercial || null,
    direccion: {
      departamento: receptor.departamento,
      municipio:    receptor.municipio,
      distrito:     receptor.distrito,
      complemento:  receptor.complemento,
    },
    telefono:        receptor.telefono || null,
    correo:          receptor.correo || order.email || null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  TIPO 05 — Nota de Crédito (ajuste sobre un CCF ya emitido)
//  docRelacionado = { codigoGeneracion, fecEmi } del CCF original
// ════════════════════════════════════════════════════════════════════════════
function buildNotaCredito(order, receptor, docRelacionado, opts) {
  const { fecEmi, horEmi } = nowSV();
  const items = normalizeItems(JSON.parse(order.items || '[]'));
  const refDoc = docRelacionado.codigoGeneracion || null;

  const cuerpoDocumento = items.map((it, idx) => {
    const precioNeto   = round8(it.precioUnitario / (1 + IVA_RATE));
    const ventaGravada = round2(it.cantidad * precioNeto);
    // El MH exige resumen.totalIva == Σ(item.totalIva) EXACTO. Como el resumen es de 2
    // decimales, el IVA por ítem también debe ser de 2 dec; si no, la suma (p.ej. 90.7686)
    // no cuadra con el resumen redondeado (90.77) → [020] CALCULO INCORRECTO.
    const totalIva     = round2(ventaGravada * IVA_RATE);
    return {
      numItem:         idx + 1,
      tipoItem:        1,
      numeroDocumento: refDoc,    // código de generación del CCF ajustado
      cantidad:        it.cantidad,
      codigo:          null,
      codTributo:      null,
      uniMedida:       59,
      descripcion:     it.descripcion,
      precioUni:       precioNeto,
      montoDescu:      0,
      ventaNoSuj:      0,
      ventaExenta:     0,
      ventaGravada,
      tributos:        ['20'],
      noGravado:       0,
      ivaPerci:        0,
      totalIva,
      ivaRete:         0,
    };
  });

  const totalGravada = round2(cuerpoDocumento.reduce((s, c) => s + c.ventaGravada, 0));
  // El MH valida totalIva = suma de los totalIva por ítem (no el IVA recalculado sobre el total).
  // Recalcular sobre el total provoca [020] CALCULO INCORRECTO por redondeo cuando hay varios ítems.
  const iva          = round2(cuerpoDocumento.reduce((s, c) => s + c.totalIva, 0));
  const montoTotal   = round2(totalGravada + iva);

  const resumen = {
    totalNoSuj:          0,
    totalExenta:         0,
    totalGravada:        totalGravada,
    subTotalVentas:      totalGravada,
    totalDescu:          0,
    tributos: [
      { codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: iva },
    ],
    montoTotalOperacion: montoTotal,
    ivaPerci:            0,
    totalIva:            iva,
    ivaRete:             0,
    totalNoGravado:      0,
    totalPagar:          montoTotal,
    totalLetras:         numeroALetras(montoTotal),
    condicionOperacion:  1,
    observaciones:       null,
    codigoRetencionMH:   null,
  };

  // identificación de NC: incluye "fusion" (no presente en FC/CCF)
  const identificacion = buildIdentificacion('05', 4, opts.numeroControl, opts.codigoGeneracion, fecEmi, horEmi);
  identificacion.fusion = null;

  // emisor de NC: NO lleva codEstable/codPuntoVenta
  const emisor = buildEmisor();
  delete emisor.codEstable;
  delete emisor.codPuntoVenta;

  return {
    identificacion,
    documentoRelacionado: [{
      tipoDocumento:   '03',     // se ajusta un Crédito Fiscal
      tipoGeneracion:  2,        // 2 = electrónico
      numeroDocumento: refDoc,
      fechaEmision:    docRelacionado.fecEmi,
    }],
    emisor,
    receptor: {
      tipoDocumento:   '36',     // 36 = NIT
      numDocumento:    receptor.nit,
      nrc:             receptor.nrc || null,
      nombre:          receptor.nombre,
      codActividad:    receptor.codActividad,
      descActividad:   receptor.descActividad,
      nombreComercial: receptor.nombreComercial || null,
      direccion: {
        departamento: receptor.departamento,
        municipio:    receptor.municipio,
        distrito:     receptor.distrito,
        complemento:  receptor.complemento,
      },
      telefono:        receptor.telefono || null,
      correo:          receptor.correo || order.email || null,
    },
    ventaTercero:    null,
    cuerpoDocumento,
    resumen,
    apendice:        null,
  };
}

function buildIdentificacion(tipoDte, version, numControl, codGen, fecEmi, horEmi) {
  return {
    version,
    ambiente:         cfg.DTE_AMBIENTE,
    tipoDte,
    numeroControl:    numControl,
    codigoGeneracion: codGen,
    tipoModelo:       1,    // 1 = modelo previo (transmisión normal)
    tipoOperacion:    1,    // 1 = transmisión normal
    tipoContingencia: null,
    motivoContin:     null,
    fecEmi,
    horEmi,
    tipoMoneda:       'USD',
  };
}

// ─── correlativo atómico por tipo de documento ────────────────────────────────
// Correlativo por (tipo_dte, establecimiento, punto de venta). Cada sucursal/caja
// lleva su propia numeración → no hay colisiones de Número de Control al crecer.
async function nextCorrelativo(tipoDte) {
  const codEstable    = cfg.DTE_EMISOR.codEstable    || 'M001';
  const codPuntoVenta = cfg.DTE_EMISOR.codPuntoVenta || '001';
  await db.execute(
    `INSERT INTO dte_correlativos (tipo_dte, cod_estable, cod_punto_venta, seq) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE seq = seq + 1`,
    [tipoDte, codEstable, codPuntoVenta]
  );
  const [rows] = await db.execute(
    'SELECT seq FROM dte_correlativos WHERE tipo_dte=? AND cod_estable=? AND cod_punto_venta=?',
    [tipoDte, codEstable, codPuntoVenta]
  );
  return rows[0].seq;
}

// ─── MH auth (token cacheado ~23h) ────────────────────────────────────────────
let _token = null;
let _tokenExp = 0;
async function getAuthToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const body = new URLSearchParams({ user: cfg.DTE_API_USER, pwd: cfg.DTE_API_PWD });
  const r = await fetch(cfg.DTE_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SillageDTE/1.0' },
    body,
  });
  const j = await r.json();
  if (j.status !== 'OK' || !j.body?.token) {
    throw new Error('MH auth falló: ' + (j.body?.descripcion || j.message || JSON.stringify(j)));
  }
  _token    = j.body.token;             // ya viene con prefijo "Bearer "
  _tokenExp = Date.now() + 23 * 60 * 60 * 1000;
  return _token;
}

// ─── firmar con el firmador de Hacienda ───────────────────────────────────────
async function firmar(dteJson) {
  const payload = {
    nit:            cfg.DTE_EMISOR.nit,
    activo:         true,
    passwordPri:    cfg.DTE_CERT_PWD,
    dteJson,
  };
  const r = await fetch(cfg.DTE_FIRMADOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const j = await r.json();
  if (j.status !== 'OK' || !j.body) {
    throw new Error('Firmador falló: ' + JSON.stringify(j.body || j));
  }
  return j.body; // JWS firmado (string)
}

// ─── transmitir a recepción MH ────────────────────────────────────────────────
async function transmitir(tipoDte, version, codigoGeneracion, documentoFirmado) {
  const token = await getAuthToken();
  const payload = {
    ambiente:    cfg.DTE_AMBIENTE,
    idEnvio:     Date.now() % 1e9,
    version,
    tipoDte,
    documento:   documentoFirmado,
    codigoGeneracion,
  };
  const r = await fetch(cfg.DTE_RECEPCION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'User-Agent': 'SillageDTE/1.0',
    },
    body: JSON.stringify(payload),
  });
  return r.json(); // { estado, selloRecibido, descripcionMsg, observaciones, ... }
}

// ─── persistencia ─────────────────────────────────────────────────────────────
async function persist(rec) {
  await db.execute(
    `INSERT INTO dte_documents
       (order_id, tipo_dte, version, ambiente, codigo_generacion, numero_control,
        sello_recibido, estado, observaciones, json_dte, json_firmado, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      rec.orderId, rec.tipoDte, rec.version, cfg.DTE_AMBIENTE,
      rec.codigoGeneracion, rec.numeroControl,
      rec.selloRecibido || null, rec.estado, rec.observaciones || null,
      JSON.stringify(rec.jsonDte), rec.jsonFirmado || null,
      new Date(), new Date(),
    ]
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  Orquestador público
// ════════════════════════════════════════════════════════════════════════════
//  emitForOrder(order, { tipoDte, receptor, docRelacionado })
//    tipoDte default '01'. Returns the DTE record (with sello) or null if
//    DTE is disabled. Never throws into the caller's happy-path on transport
//    failure — it stores estado 'RECHAZADO'/'CONTINGENCIA' so it can be retried.
// ════════════════════════════════════════════════════════════════════════════
async function emitForOrder(order, options = {}) {
  if (!cfg.DTE_ENABLED) return null;

  const tipoDte = options.tipoDte || '01';
  const version = tipoDte === '01' ? 2 : 4;   // FC v2, CCF/NC v4
  const codigoGeneracion = uuidUpper();
  const correlativo      = await nextCorrelativo(tipoDte);
  const numControl       = numeroControl(tipoDte, correlativo);
  const opts = { numeroControl: numControl, codigoGeneracion };

  let jsonDte;
  if (tipoDte === '01')      jsonDte = buildFactura(order, opts);
  else if (tipoDte === '03') jsonDte = buildCreditoFiscal(order, options.receptor || {}, opts);
  else if (tipoDte === '05') jsonDte = buildNotaCredito(order, options.receptor || {}, options.docRelacionado || {}, opts);
  else throw new Error('tipoDte no soportado: ' + tipoDte);

  const base = {
    orderId: order.id, tipoDte, version,
    codigoGeneracion, numeroControl: numControl, jsonDte,
  };

  try {
    const firmado  = await firmar(jsonDte);
    const recepcion = await transmitir(tipoDte, version, codigoGeneracion, firmado);
    const estado   = recepcion.estado === 'PROCESADO' ? 'PROCESADO' : 'RECHAZADO';
    // Capturar TODO el motivo: descripcionMsg + observaciones[] + codigoMsg.
    // (Antes: si observaciones era [] vacío, se perdía el descripcionMsg → rechazo "sin mensaje".)
    const obsArr = Array.isArray(recepcion.observaciones)
      ? recepcion.observaciones.filter(Boolean)
      : (recepcion.observaciones ? [String(recepcion.observaciones)] : []);
    const partes = [];
    if (recepcion.descripcionMsg) partes.push(recepcion.descripcionMsg);
    if (obsArr.length)            partes.push(obsArr.join(' | '));
    let observaciones = partes.join(' — ') || null;
    if (estado === 'RECHAZADO' && recepcion.codigoMsg) {
      observaciones = '[' + recepcion.codigoMsg + '] ' + (observaciones || 'Rechazado sin descripción');
    }
    const rec = {
      ...base,
      jsonFirmado:  firmado,
      selloRecibido: recepcion.selloRecibido || null,
      estado,
      observaciones,
    };
    await persist(rec);
    return rec;
  } catch (e) {
    // Falla de red/firmador → guardar en contingencia para reintento manual.
    const rec = { ...base, jsonFirmado: null, selloRecibido: null, estado: 'CONTINGENCIA', observaciones: e.message };
    await persist(rec).catch(() => {});
    console.error(`DTE ${tipoDte} para orden ${order.id} quedó en contingencia:`, e.message);
    return rec;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  EVENTO DE INVALIDACIÓN (Anulación) — anula un DTE ya PROCESADO
//  Esquema anulación v2. Endpoint aparte (DTE_ANULACION_URL). No es un tipo de
//  DTE del cuerpo: referencia un DTE con sello y lo deja sin efecto.
// ════════════════════════════════════════════════════════════════════════════

// IVA del DTE a anular: FC/NC usan resumen.totalIva; el CCF lo lleva en el tributo 20.
function _montoIvaDe(json) {
  const r = json && json.resumen ? json.resumen : {};
  if (typeof r.totalIva === 'number') return round2(r.totalIva);
  if (Array.isArray(r.tributos)) {
    const t = r.tributos.find(x => x && x.codigo === '20');
    if (t && typeof t.valor === 'number') return round2(t.valor);
  }
  return 0;
}

// docRow = fila de dte_documents (con json_dte, sello, numero_control, etc.)
// motivo = { tipoAnulacion, motivoAnulacion, nombreResponsable, tipDocResponsable,
//            numDocResponsable, nombreSolicita, tipDocSolicita, numDocSolicita,
//            codigoGeneracionR? }
function buildAnulacion(docRow, motivo, opts) {
  const { fecEmi: fecAnula, horEmi: horAnula } = nowSV();
  const json = typeof docRow.json_dte === 'string' ? JSON.parse(docRow.json_dte) : docRow.json_dte;
  const e    = cfg.DTE_EMISOR;
  const rec  = (json && json.receptor) || {};
  // Documento identificación del receptor: CCF/NC llevan numDocumento/tipoDocumento;
  // la Factura de consumidor final puede no llevarlos.
  const numDoc  = rec.numDocumento || rec.nit || null;
  const tipoDoc = rec.tipoDocumento || (rec.nit ? '36' : null);

  return {
    identificacion: {
      version:          2,
      ambiente:         cfg.DTE_AMBIENTE,
      codigoGeneracion: opts.codigoGeneracion,        // UUID del EVENTO (nuevo)
      fecAnula,
      horAnula,
    },
    emisor: {
      nit:                 e.nit,
      nombre:              e.nombre,
      tipoEstablecimiento: '02',                       // CAT-009: 02 = Casa Matriz
      telefono:            e.telefono,
      correo:              e.correo,
      codEstableMH:        null,
      codEstable:          e.codEstable || null,
      codPuntoVentaMH:     null,
      codPuntoVenta:       e.codPuntoVenta || null,
      nomEstablecimiento:  e.nombreComercial || e.nombre,
    },
    documento: {
      tipoDte:           docRow.tipo_dte,
      codigoGeneracion:  docRow.codigo_generacion,     // DTE que se anula
      codigoGeneracionR: motivo.codigoGeneracionR || null, // reemplazo (solo tipo 1)
      selloRecibido:     docRow.sello_recibido,
      numeroControl:     docRow.numero_control,
      fecEmi:            (json.identificacion && json.identificacion.fecEmi) || fecAnula,
      montoIva:          _montoIvaDe(json),
      tipoDocumento:     tipoDoc,
      numDocumento:      numDoc,
      nombre:            rec.nombre || null,
      telefono:          null,
      correo:            rec.correo || null,
    },
    motivo: {
      tipoAnulacion:     motivo.tipoAnulacion || 2,    // 2 = definitiva sin reemplazo
      motivoAnulacion:   motivo.motivoAnulacion || null,
      nombreResponsable: motivo.nombreResponsable,
      tipDocResponsable: motivo.tipDocResponsable || '36',
      numDocResponsable: motivo.numDocResponsable,
      nombreSolicita:    motivo.nombreSolicita,
      tipDocSolicita:    motivo.tipDocSolicita || '36',
      numDocSolicita:    motivo.numDocSolicita,
    },
  };
}

// Transmitir el evento firmado al endpoint de anulación del MH.
async function transmitirAnulacion(codigoGeneracion, documentoFirmado) {
  const token = await getAuthToken();
  const payload = {
    ambiente:         cfg.DTE_AMBIENTE,
    idEnvio:          Date.now() % 1e9,
    version:          2,
    documento:        documentoFirmado,
    codigoGeneracion,
  };
  const r = await fetch(cfg.DTE_ANULACION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'User-Agent': 'SillageDTE/1.0' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

// Orquestador: anula un DTE PROCESADO. Persiste el evento en dte_documents con
// tipo_dte='AN'. Devuelve el registro con estado PROCESADO/RECHAZADO.
async function invalidarDte(docRow, motivo) {
  if (!cfg.DTE_ENABLED) return null;
  if (docRow.estado !== 'PROCESADO' || !docRow.sello_recibido) {
    throw new Error('Solo se puede invalidar un DTE PROCESADO con sello de recepción.');
  }
  const codigoGeneracion = uuidUpper();               // UUID del evento
  const jsonAnula = buildAnulacion(docRow, motivo, { codigoGeneracion });

  const base = {
    orderId: docRow.order_id, tipoDte: 'AN', version: 2,
    codigoGeneracion, numeroControl: 'ANULA-' + docRow.numero_control, jsonDte: jsonAnula,
  };
  try {
    const firmado   = await firmar(jsonAnula);
    const recepcion = await transmitirAnulacion(codigoGeneracion, firmado);
    const estado    = recepcion.estado === 'PROCESADO' ? 'PROCESADO' : 'RECHAZADO';
    const obsArr = Array.isArray(recepcion.observaciones)
      ? recepcion.observaciones.filter(Boolean)
      : (recepcion.observaciones ? [String(recepcion.observaciones)] : []);
    const partes = [];
    if (recepcion.descripcionMsg) partes.push(recepcion.descripcionMsg);
    if (obsArr.length)            partes.push(obsArr.join(' | '));
    let observaciones = partes.join(' — ') || null;
    if (estado === 'RECHAZADO' && recepcion.codigoMsg) {
      observaciones = '[' + recepcion.codigoMsg + '] ' + (observaciones || 'Rechazado sin descripción');
    }
    const rec = { ...base, jsonFirmado: firmado, selloRecibido: recepcion.selloRecibido || null, estado, observaciones };
    await persist(rec);
    // Si quedó PROCESADO, marcar el DTE original como anulado en sus observaciones.
    if (estado === 'PROCESADO') {
      await db.execute(
        "UPDATE dte_documents SET estado='ANULADO', updated_at=? WHERE id=?",
        [new Date(), docRow.id]
      ).catch(() => {});
    }
    return rec;
  } catch (e) {
    const rec = { ...base, jsonFirmado: null, selloRecibido: null, estado: 'CONTINGENCIA', observaciones: e.message };
    await persist(rec).catch(() => {});
    console.error(`Invalidación del DTE ${docRow.codigo_generacion} quedó en contingencia:`, e.message);
    return rec;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  EVENTO DE CONTINGENCIA — declara DTEs generados sin conexión (modelo diferido)
//  Esquema contingencia v3. Endpoint DTE_CONTINGENCIA_URL. Flujo:
//    1) generar los DTEs en modo contingencia (tipoModelo=2), firmados y guardados
//    2) declarar el evento de contingencia listando esos códigos de generación
//    3) (luego) transmitir el lote — para homologación basta con (2) PROCESADO
// ════════════════════════════════════════════════════════════════════════════
const CONTINGENCIA_TIPO = 1;   // CAT-018: 1 = No disponibilidad de sistema del MH

// Genera una Factura en modo contingencia: firmada y persistida localmente
// (estado CONTINGENCIA, aún sin sello). Devuelve su referencia para el evento.
async function buildContingenciaDte(order) {
  const codigoGeneracion = uuidUpper();
  const correlativo = await nextCorrelativo('01');
  const numControl  = numeroControl('01', correlativo);
  const jsonDte = buildFactura(order, { numeroControl: numControl, codigoGeneracion });
  jsonDte.identificacion.tipoModelo      = 2;   // 2 = diferido (contingencia)
  jsonDte.identificacion.tipoOperacion   = 2;   // 2 = contingencia
  jsonDte.identificacion.tipoContingencia = CONTINGENCIA_TIPO;
  jsonDte.identificacion.motivoContin    = 'Prueba de homologación de contingencia';
  const firmado = await firmar(jsonDte);
  await persist({
    orderId: order.id, tipoDte: '01', version: 2, codigoGeneracion,
    numeroControl: numControl, jsonDte, jsonFirmado: firmado,
    selloRecibido: null, estado: 'CONTINGENCIA', observaciones: 'Generado en contingencia',
  });
  return { codigoGeneracion, tipoDoc: '01', numeroControl: numControl, jsonFirmado: firmado };
}

// motivo = { nombreResponsable, tipoDocResponsable, numeroDocResponsable,
//            tipoContingencia?, motivoContingencia? }
function buildContingencia(dteList, motivo, opts) {
  const { fecEmi: fTransmision, horEmi: hTransmision } = nowSV();
  const e = cfg.DTE_EMISOR;
  return {
    identificacion: {
      version:          3,
      ambiente:         cfg.DTE_AMBIENTE,
      codigoGeneracion: opts.codigoGeneracion,       // UUID del EVENTO
      fTransmision,
      hTransmision,
    },
    emisor: {
      nit:                  e.nit,
      nombre:               e.nombre,
      nombreResponsable:    motivo.nombreResponsable,
      tipoDocResponsable:   motivo.tipoDocResponsable || '36',   // 36 = NIT
      numeroDocResponsable: motivo.numeroDocResponsable,
      tipoEstablecimiento:  '02',                    // CAT-009: 02 = Casa Matriz
      codEstable:           e.codEstable || null,
      codPuntoVenta:        e.codPuntoVenta || null,
      telefono:             e.telefono,
      correo:               e.correo,
    },
    detalleDTE: dteList.map((d, i) => ({
      noItem:           i + 1,
      codigoGeneracion: d.codigoGeneracion,
      tipoDoc:          d.tipoDoc,
    })),
    motivo: {
      fInicio:            fTransmision,
      fFin:               fTransmision,
      hInicio:            hTransmision,
      hFin:               hTransmision,
      tipoContingencia:   motivo.tipoContingencia || CONTINGENCIA_TIPO,
      motivoContingencia: motivo.motivoContingencia || null,
    },
  };
}

async function transmitirContingencia(firmado) {
  const token = await getAuthToken();
  const payload = { nit: cfg.DTE_EMISOR.nit, documento: firmado };
  const r = await fetch(cfg.DTE_CONTINGENCIA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'User-Agent': 'SillageDTE/1.0' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

// Orquestador: genera `orders.length` DTEs en contingencia y declara el evento.
// Persiste el evento como tipo_dte='CG'. Devuelve el registro del evento.
async function emitContingencia(orders, motivo) {
  if (!cfg.DTE_ENABLED) return null;
  const dteList = [];
  for (const order of orders) dteList.push(await buildContingenciaDte(order));

  const codigoGeneracion = uuidUpper();
  const jsonEvent = buildContingencia(dteList, motivo, { codigoGeneracion });
  const base = {
    orderId: 'CONTINGENCIA', tipoDte: 'CG', version: 3,
    codigoGeneracion, numeroControl: 'CONTIN-' + codigoGeneracion.slice(0, 8), jsonDte: jsonEvent,
  };
  try {
    const firmado   = await firmar(jsonEvent);
    const recepcion = await transmitirContingencia(firmado);
    const ok        = recepcion.estado === 'RECIBIDO' || recepcion.estado === 'PROCESADO';
    const estado    = ok ? 'PROCESADO' : 'RECHAZADO';
    const obsArr = Array.isArray(recepcion.observaciones)
      ? recepcion.observaciones.filter(Boolean)
      : (recepcion.observaciones ? [String(recepcion.observaciones)] : []);
    const partes = [];
    if (recepcion.descripcionMsg) partes.push(recepcion.descripcionMsg);
    if (obsArr.length)            partes.push(obsArr.join(' | '));
    let observaciones = partes.join(' — ') || null;
    if (!ok && recepcion.codigoMsg) {
      observaciones = '[' + recepcion.codigoMsg + '] ' + (observaciones || 'Rechazado sin descripción');
    }
    // El evento devuelve un idRecepcion/selloRecibido según el ambiente.
    const sello = recepcion.selloRecibido || recepcion.idRecepcion || null;
    const rec = { ...base, jsonFirmado: firmado, selloRecibido: sello, estado, observaciones };
    await persist(rec);
    return rec;
  } catch (e) {
    const rec = { ...base, jsonFirmado: null, selloRecibido: null, estado: 'CONTINGENCIA', observaciones: e.message };
    await persist(rec).catch(() => {});
    console.error('Evento de contingencia quedó en contingencia:', e.message);
    return rec;
  }
}

// URL pública de verificación en el portal de Hacienda (para QR / factura).
function verificacionUrl(codigoGeneracion, fecEmi) {
  return `https://admin.factura.gob.sv/consultaPublica?ambiente=${cfg.DTE_AMBIENTE}` +
         `&codGen=${codigoGeneracion}&fechaEmi=${fecEmi}`;
}

async function getByOrderId(orderId) {
  const [rows] = await db.execute(
    'SELECT * FROM dte_documents WHERE order_id=? ORDER BY id DESC', [orderId]
  );
  return rows;
}

// ─── Diagnóstico de conectividad (no emite ningún DTE) ────────────────────────
// Verifica que (1) el firmador responde y (2) la autenticación con Hacienda
// funciona. Útil para el panel admin antes de intentar emitir facturas reales.
async function checkConnectivity() {
  const out = { ambiente: cfg.DTE_AMBIENTE, mhBase: cfg.DTE_MH_BASE, firmador: {}, mhAuth: {} };

  // (1) Firmador alcanzable — cualquier respuesta HTTP = alcanzable (red OK).
  try {
    const r = await fetch(cfg.DTE_FIRMADOR_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ping: true }),
    });
    out.firmador = { ok: true, msg: 'Firmador alcanzable (HTTP ' + r.status + ').' };
  } catch (e) {
    out.firmador = { ok: false, msg: 'No se pudo contactar el firmador: ' + e.message };
  }

  // (2) Auth con el Ministerio de Hacienda.
  if (!cfg.DTE_API_PWD) {
    out.mhAuth = { ok: false, msg: 'Falta DTE_API_PWD (contraseña API del MH).' };
  } else {
    try {
      _token = null; _tokenExp = 0;   // forzar token fresco
      await getAuthToken();
      out.mhAuth = { ok: true, msg: 'Autenticación con Hacienda OK (' + cfg.DTE_MH_BASE + ').' };
    } catch (e) {
      out.mhAuth = { ok: false, msg: e.message };
    }
  }
  return out;
}

module.exports = {
  emitForOrder,
  getByOrderId,
  verificacionUrl,
  checkConnectivity,
  numeroALetras,           // exported for tests
  buildFactura,
  buildCreditoFiscal,
  buildNotaCredito,
  buildAnulacion,
  invalidarDte,
  buildContingencia,
  emitContingencia,
  IVA_RATE,
};
