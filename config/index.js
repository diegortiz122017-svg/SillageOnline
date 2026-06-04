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
  codActividad:        process.env.DTE_COD_ACTIVIDAD || '47730', // venta de perfumes/cosméticos
  descActividad:       process.env.DTE_DESC_ACTIVIDAD || 'Venta al por menor de perfumes y cosméticos',
  // Dirección fiscal real de Sillage (tarjeta NRC): Barrio El Carmen,
  // Distrito de San Juan Talpa, Municipio de La Paz Oeste, Depto. de La Paz.
  // Códigos del catálogo territorial oficial (reforma 2024): 08 / 03 / 11.
  departamento:        process.env.DTE_DEPARTAMENTO || '08',   // 08 = La Paz
  municipio:           process.env.DTE_MUNICIPIO    || '03',   // 03 = La Paz Oeste
  distrito:            process.env.DTE_DISTRITO     || '11',   // 11 = San Juan Talpa
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
const RATE_LIMIT_MAX       = 100;
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
  OPENAI_API_KEY,
  ADMIN_USER, ADMIN_PASS,
  DTE_ENABLED, DTE_AMBIENTE, DTE_MH_BASE,
  DTE_AUTH_URL, DTE_RECEPCION_URL, DTE_ANULACION_URL,
  DTE_FIRMADOR_URL, DTE_API_USER, DTE_API_PWD, DTE_CERT_PWD, DTE_EMISOR,
  CACHE_TTL_CATALOGUE, CACHE_TTL_INVENTORY, CACHE_TTL_PRICING,
  CACHE_TTL_TOOL, CACHE_TTL_REPLY,
  RATE_LIMIT_WINDOW, RATE_LIMIT_MAX,
  ANON_SESSION_TTL, ANON_WS_LIMIT, ANON_SOMMELIER_MAX,
  REG_SOMMELIER_LIMIT, ANON_SOMMELIER_LIMIT,
  DEFAULT_BRAND_HIERARCHY,
};
