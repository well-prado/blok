# Build stage
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Copy solution and project files first for layer caching
COPY Nanoservice.Core.sln ./
COPY src/Nanoservice.Core/Nanoservice.Core.csproj src/Nanoservice.Core/
COPY tests/Nanoservice.Core.Tests/Nanoservice.Core.Tests.csproj tests/Nanoservice.Core.Tests/
RUN dotnet restore

# Copy all source code
COPY . .

# Build and publish
RUN dotnet publish src/Nanoservice.Core/Nanoservice.Core.csproj \
    -c Release \
    -o /app/publish \
    --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS runtime
WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
ENV PORT=8080
ENV Logging__LogLevel__Microsoft.AspNetCore=Warning

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["dotnet", "Nanoservice.Core.dll"]
