# Firmador Electrónico MH — despliegue en Railway

Servicio que firma los DTEs de Sillage con el certificado del Ministerio de
Hacienda. Corre como un **servicio aparte** dentro del mismo proyecto Railway
que la app Node, accesible **solo por red privada** (nunca público — contiene
la llave privada del certificado).

## 1. Conseguir el JAR del firmador

1. Entra a [factura.gob.sv](https://www.mh.gob.sv/facturacion-electronica/) →
   sección **Documentos técnicos / Descargas**.
2. Descarga el **Firmador Electrónico** (paquete oficial del MH, un JAR de
   Spring Boot, suele llamarse `svfe-api-firmador.jar` o similar).
3. Renómbralo a `firmador.jar` y colócalo en esta carpeta (`firmador/`).

> El JAR **no** se versiona en git (ver `.gitignore`). Cada quien lo descarga.

## 2. Crear el servicio en Railway

1. En tu proyecto de Railway → **New Service → Empty Service** (o "Deploy from
   repo" apuntando al subdirectorio `firmador/`).
2. En **Settings → Build**, usa el `Dockerfile` de esta carpeta
   (Root Directory = `firmador`).
3. Railway construye la imagen y levanta el firmador en el puerto `8113`.
4. **NO** le asignes dominio público. Déjalo solo en red privada.

## 3. Subir el certificado (volumen)

El firmador lee certificados desde `/firmador/uploads/{NIT}.crt`.

1. En el servicio del firmador → **Settings → Volumes** → crea un volumen
   montado en `/firmador/uploads`.
2. Sube el archivo del certificado **renombrado a tu NIT**:

   ```
   08230505261016.crt
   ```

   (es el `Certificado_08230505261016.crt` que descargaste del MH).

## 4. Conectar la app Node al firmador

En el servicio **Node (Sillage)**, agrega las variables de entorno:

```bash
DTE_ENABLED=true
DTE_AMBIENTE=00                         # 00 = pruebas, 01 = producción
DTE_FIRMADOR_URL=http://firmador.railway.internal:8113/firmardocumento/
DTE_CERT_PWD=qZ6+phx!qm%-4RnyVi          # clave privada del certificado
DTE_API_USER=08230505261016             # NIT (ya es el default)
DTE_API_PWD=<contraseña del API de transmisión MH>
```

> `firmador.railway.internal` es el hostname privado del servicio — ajústalo al
> nombre exacto que le pongas al servicio del firmador en Railway.

## 5. Probar

1. Redespliega el Node.
2. Haz un pedido de prueba y márcalo como pagado.
3. Revisa el panel admin → debería aparecer el DTE con estado `PROCESADO` y un
   `selloRecibido`. Si queda en `CONTINGENCIA`, revisa los logs (firmador caído,
   credenciales del API, o JSON rechazado por el MH).

## Notas de seguridad

- El firmador **nunca** debe tener dominio público.
- La llave privada compartida durante el registro de pruebas debe **regenerarse**
  antes de pasar a producción (`DTE_AMBIENTE=01`).
