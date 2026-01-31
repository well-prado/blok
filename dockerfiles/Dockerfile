# Base image with both Python and Bun
FROM python:3.11-slim-bookworm

# Install Bun
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    unzip \
    && curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -s /root/.bun/bin/bunx /usr/local/bin/bunx \
    && rm -rf /var/lib/apt/lists/*

# Install Supervisor
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set up working directories
WORKDIR /app
COPY . .


# Install Python dependencies
RUN if [ -f ./.blokctl/runtimes/python3/requirements.txt ]; then \
    pip install --no-cache-dir -r ./.blokctl/runtimes/python3/requirements.txt; \
    fi

# Install dependencies
RUN bun install
# Build the application
RUN bun run build

# Configure Supervisor
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Set environment variables
ENV WORKFLOWS_PATH=/app/workflows
ENV CONSOLE_LOG_ACTIVE=true
ENV NODE_ENV=production
ENV APP_NAME=blok-http

# Expose ports (Node.js on 3000, Python on 8000)
EXPOSE 4000/tcp
EXPOSE 9091/tcp

# Start Supervisor
ENTRYPOINT ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf", "-e", "debug"]