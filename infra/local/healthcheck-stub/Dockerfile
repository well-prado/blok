# A tiny stand-in for the real `blok/runtime` image — serves 200 on /health-check
# (the chart's liveness/readiness path) so you can verify the whole local pipeline
# (kind + helm + service + probes) WITHOUT building a full Blok app first.
# Real usage: `make image APP_DIR=/path/to/your/blok/project`.
FROM python:3.11-slim
COPY server.py /server.py
EXPOSE 4000
# Runs fine under the chart's securityContext (non-root, readOnlyRootFilesystem).
CMD ["python", "/server.py"]
