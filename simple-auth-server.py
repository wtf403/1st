#!/usr/bin/env python3
import hashlib
import hmac
import os
import secrets
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

LOGIN = "admin"
PASSWORD = "ValueVaults"
SECRET = "ValueVaults-simple-auth-secret-v1"
COOKIE_NAME = "simple_auth_session"

# Connection pool configuration
MAX_THREADS = int(os.environ.get("MAX_THREADS", "100"))
REQUEST_QUEUE_SIZE = int(os.environ.get("REQUEST_QUEUE_SIZE", "200"))


def sign(value: str) -> str:
    return hmac.new(SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()


def make_session() -> str:
    value = secrets.token_urlsafe(32)
    return value + "." + sign(value)


def valid_session(header: str) -> bool:
    if not header:
        return False
    jar = cookies.SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return False
    morsel = jar.get(COOKIE_NAME)
    if not morsel:
        return False
    raw = morsel.value
    if "." not in raw:
        return False
    value, signature = raw.rsplit(".", 1)
    return hmac.compare_digest(signature, sign(value))


LOGIN_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Login</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: radial-gradient(circle at top, #1e3a8a 0, #0f172a 42%, #020617 100%);
      color: #fff;
    }
    .card {
      width: min(100%, 420px);
      padding: 28px;
      border: 1px solid rgba(148, 163, 184, .24);
      border-radius: 24px;
      background: rgba(15, 23, 42, .86);
      box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
      backdrop-filter: blur(12px);
    }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -.03em; }
    p { margin: 0 0 22px; color: #cbd5e1; line-height: 1.45; }
    label { display: block; margin: 14px 0 7px; color: #dbeafe; font-weight: 650; font-size: 14px; }
    input {
      width: 100%;
      min-height: 48px;
      padding: 13px 14px;
      border: 1px solid #334155;
      border-radius: 14px;
      outline: none;
      background: #0f172a;
      color: #fff;
      font-size: 16px;
    }
    input:focus { border-color: #60a5fa; box-shadow: 0 0 0 4px rgba(96, 165, 250, .18); }
    button {
      width: 100%;
      min-height: 50px;
      margin-top: 20px;
      border: 0;
      border-radius: 14px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: white;
      font-weight: 800;
      font-size: 16px;
      cursor: pointer;
    }
    .error {
      margin: 0 0 16px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(239, 68, 68, .16);
      border: 1px solid rgba(248, 113, 113, .35);
      color: #fecaca;
    }
    .hint { margin-top: 16px; font-size: 13px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Authorization Required</h1>
    <p>Sign in to continue.</p>
    __ERROR__
    <form method="post" action="/login">
      <input type="hidden" name="next" value="__NEXT__">
      <label for="login">Login</label>
      <input id="login" name="login" autocomplete="username" autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password">
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "SimpleAuth/1.0"

    def log_message(self, fmt, *args):
        print(
            "%s - - [%s] %s"
            % (self.address_string(), self.log_date_time_string(), fmt % args),
            flush=True,
        )

    def send_plain(self, code, text):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/auth-check":
            if valid_session(self.headers.get("Cookie", "")):
                self.send_response(204)
                self.end_headers()
            else:
                self.send_response(401)
                self.end_headers()
            return

        if parsed.path == "/login":
            qs = parse_qs(parsed.query)
            original = (
                self.headers.get("X-Original-URI") or qs.get("next", ["/"])[0] or "/"
            )
            error = (
                '<div class="error">Invalid login or password</div>'
                if qs.get("error")
                else ""
            )
            html = LOGIN_HTML.replace("__ERROR__", error).replace(
                "__NEXT__", quote(original, safe="/%?&=:#._-")
            )
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_plain(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/login":
            self.send_plain(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8", "replace")
        data = parse_qs(raw)
        login = data.get("login", [""])[0]
        password = data.get("password", [""])[0]
        next_url = data.get("next", ["/"])[0] or "/"
        if not next_url.startswith("/") or next_url.startswith("//"):
            next_url = "/"

        if login == LOGIN and password == PASSWORD:
            session = make_session()
            self.send_response(302)
            self.send_header(
                "Set-Cookie",
                COOKIE_NAME
                + "="
                + session
                + "; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax",
            )
            self.send_header("Location", next_url)
            self.end_headers()
            return

        self.send_response(302)
        self.send_header(
            "Location", "/login?error=1&next=" + quote(next_url, safe="/%?&=:#._-")
        )
        self.end_headers()


if __name__ == "__main__":
    # Configure ThreadingHTTPServer with connection limits
    server = ThreadingHTTPServer(("127.0.0.1", 18080), Handler)
    server.daemon_threads = True  # Allow threads to exit when main thread exits
    server.block_on_close = False  # Don't block on server shutdown
    server.request_queue_size = REQUEST_QUEUE_SIZE  # Max pending connections

    print(f"Starting ThreadingHTTPServer on http://127.0.0.1:18080", flush=True)
    print(f"Configuration: MAX_THREADS={MAX_THREADS}, REQUEST_QUEUE_SIZE={REQUEST_QUEUE_SIZE}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...", flush=True)
        server.shutdown()
