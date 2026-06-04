# Firmador Electrónico MH — despliegue en Railway

Servicio que firma los DTEs de Sillage con el certificado del Ministerio de
Hacienda (proyecto oficial `svfe-api-firmador` v2.0.0). Corre como un **servicio
aparte** dentro del mismo proyecto Railway que la app Node, accesible **solo por
red privada** (nunca público — contiene la llave privada del certificado).

El código fuente del firmador ya está en esta carpeta. **Railway lo compila solo**
con Maven (Dockerfile multi-stage) — no necesitas descargar ni compilar nada.

## 1. Crear el servicio en Railway

1. En tu proyecto de Railway → **"+ New" → "GitHub Repo"** → elige el repo de Sillage.
2. En el nuevo servicio → **Settings**:
   - **Service Name**: `firmador` (importante — así lo llama el Node).
   - **Root Directory**: `firmador`
   - **Build**: detecta el `Dockerfile` automáticamente.
3. **Deploy**. El primer build tarda varios minutos (compila Java con Maven).
4. **No le asignes dominio público** (Settings → Networking → quita el dominio si
   Railway generó uno). Solo red privada.

## 2. Variables del servicio firmador

En el servicio **firmador** → **Variables**:

| Variable | Valor |
|----------|-------|
| `DTE_NIT` | `08230505261016` |
| `DTE_CERT_B64` | *(todo el contenido del archivo `cert_b64.txt`)* |

El `entrypoint.sh` decodifica el certificado y lo escribe en
`/firmador/uploads/08230505261016.crt` al arrancar.

## 3. Variables del servicio Node (Sillage)

```bash
DTE_ENABLED=true
DTE_AMBIENTE=00
DTE_FIRMADOR_URL=http://firmador.railway.internal:8113/firmardocumento/
DTE_CERT_PWD=qZ6+phx!qm%-4RnyVi          # clave privada del certificado
DTE_API_PWD=<contraseña del portal MH>   # misma con la que inicias sesión en Hacienda
```

(`DTE_API_USER` = NIT, ya es el default.)

## 4. Probar

1. Revisa los **logs del firmador**: debe decir
   `Certificado escrito en /firmador/uploads/08230505261016.crt` y arrancar en `:8113`.
2. Haz un pedido de prueba y márcalo pagado (o usa el endpoint admin de DTE).
3. En el panel admin debe aparecer el DTE con estado `PROCESADO` y `selloRecibido`.
   Si queda en `CONTINGENCIA`, revisa los logs (firmador, `DTE_API_PWD`, o JSON
   rechazado por el MH).

## Notas

- El firmador escucha en `8113` con perfil `nonssl` (HTTP plano, seguro porque
  solo vive en la red privada de Railway).
- La llave privada compartida durante el registro de pruebas debe **regenerarse**
  antes de pasar a producción (`DTE_AMBIENTE=01`).
- Los esquemas JSON oficiales validados están en `../services/dte-schemas/`.
