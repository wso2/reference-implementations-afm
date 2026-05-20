# Build stage (discarded after build)
FROM ballerina/ballerina:2201.12.10 AS builder

USER root

WORKDIR /app

COPY Ballerina.toml .
COPY *.bal .
COPY modules ./modules

RUN bal build

FROM eclipse-temurin:21-jre-alpine-3.23

RUN apk add --no-cache gcompat libc6-compat libgcc

ENV LD_PRELOAD=/lib/libgcompat.so.0

WORKDIR /app

COPY --from=builder --chown=10014:0 /app/target/bin/afm_ballerina.jar ./
COPY --chown=10014:0 resources ./resources

USER 10014

ENTRYPOINT ["java", "-jar", "afm_ballerina.jar"]
