#!/bin/sh
# Escribe el certificado MH desde la variable de entorno (base64) al disco,
# donde el firmador lo espera ({workdir}/uploads/{NIT}.crt), y arranca el firmador.
#
# Variables requeridas:
#   DTE_NIT        → NIT del emisor (nombre del archivo .crt)
#   DTE_CERT_B64   → contenido del .crt codificado en base64
set -e

mkdir -p /firmador/uploads

if [ -n "$DTE_CERT_B64" ] && [ -n "$DTE_NIT" ]; then
  echo "$DTE_CERT_B64" | base64 -d > "/firmador/uploads/${DTE_NIT}.crt"
  echo "Certificado escrito en /firmador/uploads/${DTE_NIT}.crt"
else
  echo "ADVERTENCIA: DTE_CERT_B64 o DTE_NIT no están definidos — el firmador no podrá firmar."
fi

# Perfil 'nonssl' = servidor HTTP plano en el puerto 8113 (red privada de Railway).
exec java \
  --add-opens java.base/java.math=ALL-UNNAMED \
  --add-opens java.base/java.time=ALL-UNNAMED \
  -jar /firmador/app.jar \
  --spring.profiles.active=nonssl
