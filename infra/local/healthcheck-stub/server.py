"""Minimal /health-check responder on :4000 — a stand-in for blok/runtime to
verify the local Kubernetes pipeline (kind + helm + probes) end to end."""
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok","stub":true}')

    def log_message(self, *args):  # quiet
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 4000), Handler).serve_forever()
