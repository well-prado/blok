# Build stage
FROM maven:3.9-eclipse-temurin-17 AS builder

WORKDIR /app

# Copy project files
COPY pom.xml .
RUN mvn dependency:resolve -q

# Copy source code
COPY src ./src

# Build fat JAR (skip tests for faster Docker builds)
RUN mvn package -DskipTests -q

# Runtime stage
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY --from=builder /app/target/nanoservice-java-1.0.0.jar ./nanoservice.jar

EXPOSE 8080

ENV PORT=8080
ENV VERSION=1.0.0

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

ENTRYPOINT ["java", "-jar", "nanoservice.jar"]
