# CDP screencast spike

This proves the risky live-browser transport independently of the BLOK runner and canvas.

```bash
bunx playwright install chromium
bun run studio:cdp-spike
```

Use `bun run studio:cdp-spike --keep-open` to keep the viewer URL available for manual inspection.

The self-check launches headless Chromium, streams CDP JPEG frames at no more than 10 FPS, performs `goto`, `fill`, and `click`, and captures screenshots. The viewer intentionally delays acknowledgements so the server must drop intermediate frames and retain only the latest one. A passing run also closes the CDP session, browser, WebSocket server, and HTTP server.
