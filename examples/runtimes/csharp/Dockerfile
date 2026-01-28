# Build stage
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder

WORKDIR /app

# Copy project file and restore dependencies (cached layer)
COPY BlokRuntime.csproj .
RUN dotnet restore

# Copy source code
COPY src/ ./src/

# Build the application
RUN dotnet publish -c Release -o /app/publish --no-restore

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine

WORKDIR /app

# Copy the published output from builder
COPY --from=builder /app/publish .

# Expose port
EXPOSE 8080

# Set environment variables
ENV PORT=8080
ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run the application
ENTRYPOINT ["dotnet", "BlokRuntime.dll"]
