# ── Firmador Electrónico del Ministerio de Hacienda (El Salvador) ─────────────
# Servicio aparte que firma los DTEs con el certificado del emisor.
# Corre en Railway como su propio servicio, accesible solo por red privada.
#
# IMPORTANTE: el JAR del firmador NO se incluye en este repo. Descárgalo del
# portal oficial (factura.gob.sv → Documentos técnicos / Descargas → "Firmador")
# y colócalo en esta carpeta como `firmador.jar` antes de construir la imagen.
#
# El certificado .crt tampoco va en la imagen — se monta por volumen de Railway
# en /firmador/uploads (ver README.md).

FROM eclipse-temurin:17-jre-jammy

WORKDIR /firmador

# El firmador lee los certificados desde ./uploads, nombrados {NIT}.crt
RUN mkdir -p /firmador/uploads

# JAR oficial del firmador (debes colocarlo en firmador/firmador.jar)
COPY firmador.jar /firmador/firmador.jar

# Puerto interno del firmador (no se expone públicamente en Railway)
EXPOSE 8113

# Railway inyecta $PORT, pero el firmador usa 8113 fijo internamente.
ENTRYPOINT ["java", "-jar", "/firmador/firmador.jar"]
