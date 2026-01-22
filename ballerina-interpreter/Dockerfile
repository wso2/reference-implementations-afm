# Build stage (discarded after build)
FROM ballerina/ballerina:2201.12.10 AS builder

USER root

WORKDIR /app

COPY Ballerina.toml .
COPY *.bal .
COPY modules ./modules

RUN bal build

# Runtime stage - slim JRE only
FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=builder --chown=10014:0 /app/target/bin/afm_ballerina.jar ./
COPY --chown=10014:0 resources ./resources

USER 10014

ENTRYPOINT ["java", "-jar", "afm_ballerina.jar"]
