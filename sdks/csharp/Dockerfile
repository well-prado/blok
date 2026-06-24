# Build stage
# .NET 10 SDK — the projects target net10.0 (sdk:9.0 fails with NETSDK1045).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy solution and project files first for layer caching
COPY Blok.Core.sln ./
COPY src/Blok.Core/Blok.Core.csproj src/Blok.Core/
COPY tests/Blok.Core.Tests/Blok.Core.Tests.csproj tests/Blok.Core.Tests/
RUN dotnet restore

# Copy all source code
COPY . .

# Build and publish
RUN dotnet publish src/Blok.Core/Blok.Core.csproj \
    -c Release \
    -o /app/publish \
    --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS runtime
WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
ENV PORT=8080
ENV GRPC_PORT=10004
ENV Logging__LogLevel__Microsoft.AspNetCore=Warning

# HTTP port (informational /health) + gRPC port (the runner only speaks gRPC).
EXPOSE 8080 10004

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["dotnet", "Blok.Core.dll"]
