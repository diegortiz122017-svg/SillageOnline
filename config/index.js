'use strict';

// ─── Environment validation ───────────────────────────────────────────────────
const required = ['SESSION_SECRET', 'MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length && process.env.NODE_ENV === 'production') {
  console.error(`🚨 Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── App ──────────────────────────────────────────────────────────────────────
const PORT     = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD  = NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || 'https://sillage-sv.com';

// ─── Auth ─────────────────────────────────────────────────────────────────────
const SESSION_SECRET      = process.env.SESSION_SECRET || null;
const SESSION_TTL_ADMIN   = 8  * 60 * 60 * 1000;   // 8 hours
const SESSION_TTL_CUSTOMER = 60 * 24 * 60 * 60 * 1000; // 60 days

// ─── Database ─────────────────────────────────────────────────────────────────
const DB = {
  host:     process.env.MYSQL_HOST,
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl:      process.env.MYSQLSSL_CA
    ? { ca: process.env.MYSQLSSL_CA, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
    : undefined,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 10000,
};

// ─── Email ────────────────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const FROM_EMAIL     = process.env.FROM_EMAIL || 'noreply@sillage-sv.com';
const EMAIL_HOLA     = process.env.EMAIL_HOLA    || 'hola@sillage-sv.com';
const EMAIL_PEDIDOS  = process.env.EMAIL_PEDIDOS || 'pedidos@sillage-sv.com';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || null; // email to receive new order alerts

// ─── Payments ─────────────────────────────────────────────────────────────────
const WOMPI_CLIENT_ID     = process.env.WOMPI_CLIENT_ID     || null;
const WOMPI_CLIENT_SECRET = process.env.WOMPI_CLIENT_SECRET || null;
const WOMPI_PUBLIC_KEY    = process.env.WOMPI_PUBLIC_KEY    || null; // pub_... from Wompi panel

// PayPal — tarjeta de crédito/débito vía Smart Buttons (Orders API v2).
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     || null;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || null;
// 'sandbox' (pruebas) o 'live' (cobros reales) — cambia el host de la API de PayPal.
const PAYPAL_MODE = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const PAYPAL_API_BASE = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// PayWay One (Banco Cuscatlán) — tarjeta de crédito/débito vía botón/modal JS.
// Master switch: mientras esté en false el código queda inerte aunque ya esté
// desplegado — igual que DTE_ENABLED. Prender solo una vez estén las
// credenciales configuradas (mismo patrón que el resto de pasarelas: nunca
// se hardcodean, solo variables de entorno).
const PAYWAY_ENABLED         = process.env.PAYWAY_ENABLED === 'true';
const PAYWAY_TOKEN           = process.env.PAYWAY_TOKEN           || null; // Token Autenticación
const PAYWAY_RETAILER_OWNER  = process.env.PAYWAY_RETAILER_OWNER  || null; // ID Comercio
const PAYWAY_USER_OPERATION  = process.env.PAYWAY_USER_OPERATION  || null; // Usuario Operación
const PAYWAY_ENCRYPTION_KEY  = process.env.PAYWAY_ENCRYPTION_KEY  || null; // Token Encriptación (nunca exponer al cliente)
// 'test' o 'prod' — cambia el dominio de los scripts/servicios de PayWay.
const PAYWAY_MODE   = process.env.PAYWAY_MODE === 'prod' ? 'prod' : 'test';
const PAYWAY_DOMAIN = PAYWAY_MODE === 'prod' ? 'www.payway.sv' : 'test.payway.sv';
const PAYWAY_JS_URL = `https://${PAYWAY_DOMAIN}/web-payway-sv/resources/js/paywayOneButton.js`;

// ─── AI ───────────────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// ─── DTE / Factura Electrónica (Ministerio de Hacienda, El Salvador) ──────────
// Master switch. When false, no DTE is emitted — the order flow is untouched.
// Turn on only once the certificate + API credentials are in place.
const DTE_ENABLED = process.env.DTE_ENABLED === 'true';

// Ambiente: '00' = pruebas (apitest), '01' = producción.
const DTE_AMBIENTE = process.env.DTE_AMBIENTE || '00';

// MH endpoints differ per ambiente.
const DTE_MH_BASE = DTE_AMBIENTE === '01'
  ? 'https://api.dtes.mh.gob.sv'
  : 'https://apitest.dtes.mh.gob.sv';
const DTE_AUTH_URL     = `${DTE_MH_BASE}/seguridad/auth`;
const DTE_RECEPCION_URL = `${DTE_MH_BASE}/fesv/recepciondte`;
const DTE_ANULACION_URL = `${DTE_MH_BASE}/fesv/anulardte`;
const DTE_CONTINGENCIA_URL = `${DTE_MH_BASE}/fesv/contingencia`;
const DTE_LOTE_URL = `${DTE_MH_BASE}/fesv/recepcion/lote`;

// Firmador oficial de Hacienda (corre como contenedor/JAR local).
const DTE_FIRMADOR_URL = process.env.DTE_FIRMADOR_URL || 'http://localhost:8113/firmardocumento/';

// API credentials (MH portal). User = NIT del emisor por defecto.
const DTE_API_USER = process.env.DTE_API_USER || '08230505261016';
const DTE_API_PWD  = process.env.DTE_API_PWD  || null;
// Clave privada del certificado (para el firmador).
const DTE_CERT_PWD = process.env.DTE_CERT_PWD || null;

// Datos tributarios del emisor (Sillage). Defaults reales tomados del
// certificado MH (NIT 0823-050526-101-6, NRC 3869539). Se pueden sobreescribir
// con variables de entorno.
const DTE_EMISOR = {
  nit:                 process.env.DTE_NIT  || '08230505261016',  // 14 dígitos sin guiones
  nrc:                 process.env.DTE_NRC  || '3869539',         // sin guiones
  nombre:              process.env.DTE_NOMBRE || 'SILLAGE, SOCIEDAD POR ACCIONES SIMPLIFICADA DE CAPITAL VARIABLE',
  nombreComercial:     process.env.DTE_NOMBRE_COMERCIAL || 'Sillage Parfumerie',
  // CAT-019 Actividad Económica (catálogo oficial MH). '47730' NO existe → rechazo [003].
  // Código correcto para venta al por menor de perfumería/cosméticos: 47722.
  codActividad:        '47722',
  descActividad:       'Venta al por menor de productos cosméticos y de tocador',
  // Dirección fiscal real de Sillage (tarjeta NRC): Barrio El Carmen,
  // Dirección fiscal: Distrito San Juan Talpa, Municipio La Paz Oeste, Depto. La Paz.
  // Códigos FIJOS (sin env) tomados del catálogo OFICIAL del MH (reforma territorial 2024):
  //   CAT-012 Departamento → 08  = La Paz
  //   CAT-013 Municipio    → 23  = La Paz Oeste   (los municipios NUEVOS recibieron códigos
  //                                                 altos: ej. 23 San Salvador Centro, 23 La Paz Oeste)
  //   CAT-008 Distrito     → 11  = San Juan Talpa
  // OJO: NO son los componentes "03"/"0803" del catálogo del SSF — el DTE usa el CAT-013.
  departamento:        '08',     // CAT-012: La Paz
  municipio:           '23',     // CAT-013: La Paz Oeste
  distrito:            '11',     // CAT-008: San Juan Talpa
  complemento:         process.env.DTE_DIRECCION || 'Barrio El Carmen, San Juan Talpa, La Paz',
  telefono:            process.env.DTE_TELEFONO || '21000000', // 8+ dígitos (req. por esquema)
  correo:              process.env.DTE_CORREO || 'ortiz@sillage-sv.com',
  // Segmentos del Número de Control: (M|B|S|P)### y punto de venta ###.
  // codEstable debe ser 4 chars (ej. 'M001'); codPuntoVenta 1-15 chars.
  codEstable:          process.env.DTE_COD_ESTABLE    || 'M001',
  codPuntoVenta:       process.env.DTE_COD_PUNTOVENTA || '001',
};

// ─── Admin ────────────────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER?.trim() || null;
const ADMIN_PASS = process.env.ADMIN_PASS?.trim() || null;

// ─── Cache TTLs ───────────────────────────────────────────────────────────────
const CACHE_TTL_CATALOGUE  = 5  * 60 * 1000;  // 5 min
const CACHE_TTL_INVENTORY  = 30 * 1000;        // 30 sec (changes frequently)
const CACHE_TTL_PRICING    = 60 * 1000;        // 1 min
const CACHE_TTL_TOOL       = 30 * 60 * 1000;  // 30 min (Nez tool results)
const CACHE_TTL_REPLY      = 60 * 60 * 1000;  // 60 min (Nez reply cache)

// ─── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW    = 15 * 60 * 1000;  // 15 min
const RATE_LIMIT_MAX       = 400;             // per real client IP (≈27 req/min) — a SPA session makes many API calls
const ANON_SESSION_TTL     = 60 * 60 * 1000;  // 60 min
const ANON_WS_LIMIT        = 3;
const ANON_SOMMELIER_MAX   = 2;

// ─── Sommelier ────────────────────────────────────────────────────────────────
const REG_SOMMELIER_LIMIT  = 4;   // daily consult limit for registered users
const ANON_SOMMELIER_LIMIT = 2;   // daily consult limit for anonymous users

// ─── Brand prestige hierarchy (controls Collections order) ───────────────────
// Edit from admin settings in DB — this is the fallback default
const DEFAULT_BRAND_HIERARCHY = [
  'Maison Francis Kurkdjian', 'Creed', 'Tom Ford', 'Initio',
  'Parfums de Marly', 'Le Labo', 'Vilhelm Parfumerie', 'Mancera',
  'Montale', 'Chanel', 'Dior', 'Hermes', 'Jo Malone',
  'Maison Margiela', 'Prada', 'Jean Paul Gaultier',
  'Al Haramain', 'Lattafa', 'Afnan', 'Armaf', 'Ajmal', 'Zimaya', 'Sospiro',
];

module.exports = {
  PORT, NODE_ENV, IS_PROD, BASE_URL,
  SESSION_SECRET, SESSION_TTL_ADMIN, SESSION_TTL_CUSTOMER,
  DB,
  RESEND_API_KEY, FROM_EMAIL, EMAIL_HOLA, EMAIL_PEDIDOS, ADMIN_NOTIFY_EMAIL,
  WOMPI_CLIENT_ID, WOMPI_CLIENT_SECRET, WOMPI_PUBLIC_KEY,
  PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE, PAYPAL_API_BASE,
  PAYWAY_ENABLED, PAYWAY_TOKEN, PAYWAY_RETAILER_OWNER, PAYWAY_USER_OPERATION,
  PAYWAY_ENCRYPTION_KEY, PAYWAY_MODE, PAYWAY_DOMAIN, PAYWAY_JS_URL,
  OPENAI_API_KEY,
  ADMIN_USER, ADMIN_PASS,
  DTE_ENABLED, DTE_AMBIENTE, DTE_MH_BASE,
  DTE_AUTH_URL, DTE_RECEPCION_URL, DTE_ANULACION_URL, DTE_CONTINGENCIA_URL, DTE_LOTE_URL,
  DTE_FIRMADOR_URL, DTE_API_USER, DTE_API_PWD, DTE_CERT_PWD, DTE_EMISOR,
  CACHE_TTL_CATALOGUE, CACHE_TTL_INVENTORY, CACHE_TTL_PRICING,
  CACHE_TTL_TOOL, CACHE_TTL_REPLY,
  RATE_LIMIT_WINDOW, RATE_LIMIT_MAX,
  ANON_SESSION_TTL, ANON_WS_LIMIT, ANON_SOMMELIER_MAX,
  REG_SOMMELIER_LIMIT, ANON_SOMMELIER_LIMIT,
  DEFAULT_BRAND_HIERARCHY,
};
