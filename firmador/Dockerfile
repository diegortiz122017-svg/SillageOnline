# ── Firmador Electrónico del Ministerio de Hacienda (svfe-api-firmador 2.0.0) ──
# Multi-stage: Railway compila el código fuente con Maven y luego corre el JAR.
# No necesitas compilar nada localmente.
#
# El certificado .crt NO va en la imagen — el entrypoint lo escribe en
# /firmador/uploads/{NIT}.crt desde la variable de entorno DTE_CERT_B64.

# ── Stage 1: build con Maven ──────────────────────────────────────────────────
FROM maven:3.9-amazoncorretto-21 AS build
WORKDIR /build
# Cache de dependencias: primero el pom, luego el código
COPY pom.xml .
RUN mvn -B dependency:go-offline || true
COPY src ./src
RUN mvn -B clean package -DskipTests
# El pom genera el jar ejecutable con classifier "exec"
RUN cp target/svfe-api-firmador-*-exec.jar /app.jar

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM amazoncorretto:21-alpine-jdk
WORKDIR /firmador
ENV TZ=America/El_Salvador
# El firmador lee el certificado desde {workdir}/uploads/{NIT}.crt
RUN mkdir -p /firmador/uploads
COPY --from=build /app.jar /firmador/app.jar
COPY entrypoint.sh /firmador/entrypoint.sh
RUN chmod +x /firmador/entrypoint.sh
EXPOSE 8113
ENTRYPOINT ["/firmador/entrypoint.sh"]
