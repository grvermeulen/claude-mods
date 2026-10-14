"""The OpenAI side of the openai-models Claude Code mod: Sign in with ChatGPT, and inference on the plan.

  gpt.py login [--no-browser]   sign in in the browser (OAuth with PKCE, a loopback redirect)
  gpt.py status                 who is signed in; never prints a token
  gpt.py models                 the models the signed-in account can use
  gpt.py infer                  one streamed /v1/responses request, its body read from stdin
  gpt.py logout                 forget the tokens (the issued client id is kept for the next sign-in)

Every command prints one JSON object per line on stdout. Tokens live only in the
credentials file, written atomically and owner-only, and are never printed.

This follows OpenAI's "token sharing for open-source and local apps":
https://developers.openai.com/siwc/token-sharing-open-source
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

AGENT_NAME = "claude-openai-models"
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
REFRESH_MARGIN_S = 300
API = os.environ.get("CLAUDE_GPT_API_BASE", "https://api.openai.com/v1").rstrip("/")
AUTH = os.environ.get("CLAUDE_GPT_AUTH_BASE", "https://auth.openai.com").rstrip("/")
RESOURCE = "https://api.openai.com/v1"
HOME = os.environ.get("CLAUDE_GPT_HOME") or os.path.join(os.path.expanduser("~"), ".config", "claude-openai-models")
CREDENTIALS = os.path.join(HOME, "credentials.json")
LOCK = os.path.join(HOME, "refresh.lock")

# Codes after which only a new sign-in helps (Errors and recovery).
RELOGIN = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
           "refresh_token_invalidated", "refresh_token_reused"}


class Failure(Exception):
    def __init__(self, code, message, relogin=False):
        super().__init__(message)
        self.code, self.relogin = code, relogin


def emit(kind, **fields):
    sys.stdout.write(json.dumps({"type": kind, **fields}) + "\n")
    sys.stdout.flush()


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def jwt_claims(token):
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def load():
    try:
        with open(CREDENTIALS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(record):
    os.makedirs(HOME, exist_ok=True)
    temp = CREDENTIALS + f".{os.getpid()}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)
    os.replace(temp, CREDENTIALS)


def host_id(record):
    """A stable, opaque id for this machine, made once (urn:uuid, as the docs allow)."""
    return record.get("ext_agent_host_id") or f"urn:uuid:{uuid.uuid4()}"


def post_form(url, fields):
    request = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode("ascii"), method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded",
                                              "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = read_error(err)
        code = body.get("error") if isinstance(body.get("error"), str) else (body.get("error") or {}).get("code")
        raise Failure(code or f"http_{err.code}", body.get("error_description") or str(body), code in RELOGIN)


def read_error(err):
    try:
        return json.loads(err.read().decode("utf-8"))
    except Exception:
        return {"detail": err.reason}


def store_tokens(record, tokens):
    record.update({
        "id_token": tokens.get("id_token", record.get("id_token")),
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", record.get("refresh_token")),
        "token_type": tokens.get("token_type", "Bearer"),
        "expires_at": int(time.time()) + int(tokens.get("expires_in", 3600)),
        "scopes": (tokens.get("scope") or record.get("scopes") or "").split() if isinstance(tokens.get("scope"), str)
        else tokens.get("scope") or record.get("scopes") or [],
        "saved_at": int(time.time()),
    })


# --- sign-in --------------------------------------------------------------------------------------

class Callback(http.server.BaseHTTPRequestHandler):
    result = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/auth/callback":
            self.send_response(404)
            self.end_headers()
            return
        Callback.result = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        ok = "error" not in Callback.result
        page = ("<h2>Signed in.</h2><p>You can close this tab and go back to Claude Code.</p>" if ok
                else "<h2>Sign-in did not complete.</h2><p>Go back to Claude Code to see why.</p>")
        body = f"<!doctype html><meta charset=utf-8><title>Claude Code</title><body style='font-family:sans-serif'>{page}"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))


def listen():
    """The loopback listener, started before the browser opens; 1455 first, as the docs show."""
    for port in (1455, 0):
        try:
            server = socketserver.TCPServer(("127.0.0.1", port), Callback)
            return server, server.server_address[1]
        except OSError:
            continue
    raise Failure("port_unavailable", "could not open a port on 127.0.0.1 for the sign-in redirect")


def login(no_browser):
    record = load()
    record["ext_agent_host_id"] = host_id(record)
    is_new = not record.get("client_id")
    verifier = b64url(secrets.token_bytes(32))
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    server, port = listen()
    redirect = f"http://127.0.0.1:{port}/auth/callback"
    params = {
        "client_id": "dynamic_agent_client" if is_new else record["client_id"],
        "ext_agent_host_id": record["ext_agent_host_id"],
        "response_type": "code",
        "redirect_uri": redirect,
        "scope": SCOPE,
        "resource": RESOURCE,
        "state": state,
        "nonce": nonce,
        "code_challenge": b64url(hashlib.sha256(verifier.encode("ascii")).digest()),
        "code_challenge_method": "S256",
    }
    if is_new:
        params["agent_name_hint"] = AGENT_NAME
    else:
        if record.get("id_token"):
            params["id_token_hint"] = record["id_token"]
        if record.get("email"):
            params["login_hint"] = record["email"]
    url = f"{AUTH}/api/accounts/authorize?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"

    Callback.result = None
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    emit("open", url=url)
    if not no_browser:
        webbrowser.open(url)
    deadline = time.time() + 300
    while Callback.result is None and time.time() < deadline:
        time.sleep(0.2)
    server.shutdown()
    server.server_close()
    got = Callback.result
    if got is None:
        raise Failure("timeout", "no sign-in within five minutes")
    if got.get("state") != state:
        raise Failure("state_mismatch", "the sign-in answer did not match this request; nothing was saved")
    if "error" in got:
        raise Failure(got["error"], got.get("error_description") or "sign-in was not completed")
    client_id = got.get("client_id") if is_new else record["client_id"]
    if not is_new and got.get("client_id") not in (None, client_id):
        raise Failure("client_mismatch", "the sign-in answered for another client; nothing was saved")
    if not client_id:
        raise Failure("no_client_id", "the sign-in did not return a client id")

    tokens = post_form(f"{AUTH}/api/accounts/oauth/token", {
        "grant_type": "authorization_code", "client_id": client_id, "code": got["code"],
        "code_verifier": verifier, "redirect_uri": redirect, "resource": RESOURCE,
    })
    # The ID token came straight from the token endpoint over TLS, so its claims are checked
    # here; its signature is not (that needs a crypto library this script does without).
    claims = jwt_claims(tokens["id_token"])
    audience = claims.get("aud")
    if client_id not in (audience if isinstance(audience, list) else [audience]):
        raise Failure("bad_id_token", "the ID token was issued to another client; nothing was saved")
    if claims.get("nonce") != nonce or claims.get("exp", 0) < time.time():
        raise Failure("bad_id_token", "the ID token failed its nonce or expiry check; nothing was saved")
    record.update({"client_id": client_id, "email": claims.get("email"), "issuer": claims.get("iss"),
                   "subject": claims.get("sub")})
    store_tokens(record, tokens)
    save(record)
    if PLAN_SCOPE not in record["scopes"]:
        emit("signed_in", email=record["email"], plan=False)
        raise Failure("no_plan_consent", "signed in, but using your ChatGPT plan was not allowed; sign in again to allow it")
    emit("signed_in", email=record["email"], plan=True)


# --- tokens in use --------------------------------------------------------------------------------

def refreshed(record):
    """The record with a live access token, refreshing it (once, across processes) near expiry."""
    if not record.get("access_token"):
        raise Failure("not_signed_in", "not signed in: /gpt login", relogin=True)
    if record.get("expires_at", 0) - time.time() > REFRESH_MARGIN_S:
        return record
    os.makedirs(HOME, exist_ok=True)
    for _ in range(100):
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.time() - os.path.getmtime(LOCK) > 30:
                os.remove(LOCK)
            time.sleep(0.1)
    else:
        raise Failure("refresh_busy", "another refresh is running; try again")
    try:
        record = load()  # another process may have refreshed meanwhile
        if record.get("expires_at", 0) - time.time() > REFRESH_MARGIN_S:
            return record
        tokens = post_form(f"{AUTH}/api/accounts/oauth/token", {
            "grant_type": "refresh_token", "client_id": record["client_id"],
            "refresh_token": record["refresh_token"], "resource": RESOURCE,
        })
        store_tokens(record, tokens)
        save(record)
        return record
    except Failure as failure:
        if failure.relogin:
            for key in ("access_token", "refresh_token", "id_token", "expires_at"):
                record.pop(key, None)
            save(record)
        raise
    finally:
        os.close(fd)
        os.remove(LOCK)


def api(method, path, body=None):
    record = refreshed(load())
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(f"{API}{path}", data=data, method=method, headers={
        "Authorization": f"Bearer {record['access_token']}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if body and body.get("stream") else "application/json",
    })
    try:
        return urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as err:
        payload = read_error(err)
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        code = error.get("code") or f"http_{err.code}"
        message = error.get("message") or payload.get("detail") or err.reason
        raise Failure(code, f"{message} (HTTP {err.code})", relogin=err.code == 401)


def models():
    with api("GET", "/models") as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("models") or payload.get("data") or []
    listed = [{"slug": m.get("slug") or m.get("id"), "name": m.get("display_name") or m.get("slug") or m.get("id")}
              for m in rows if m.get("visibility", "list") == "list"]
    emit("models", models=[m for m in listed if m["slug"]])


def infer():
    sys.stdin.reconfigure(encoding="utf-8")
    body = json.loads(sys.stdin.read())
    body.update({"store": False, "stream": True})
    with api("POST", "/responses", body) as response:
        data = []
        for raw in response:
            line = raw.decode("utf-8").rstrip("\r\n")
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
                continue
            if line or not data:
                continue
            payload, data = "\n".join(data), []
            if payload == "[DONE]":
                break
            relay(json.loads(payload))


def relay(event):
    """One Responses stream event, as the mod reads it."""
    kind = event.get("type")
    if kind == "response.output_item.added" and event["item"].get("type") == "function_call":
        item = event["item"]
        emit("tool", item=item["id"], call_id=item["call_id"], name=item["name"])
    elif kind == "response.function_call_arguments.delta":
        emit("args", item=event["item_id"], delta=event["delta"])
    elif kind == "response.output_text.delta":
        emit("text", item=event["item_id"], delta=event["delta"])
    elif kind in ("response.completed", "response.incomplete"):
        response = event.get("response") or {}
        reason = (response.get("incomplete_details") or {}).get("reason")
        emit("done", status=response.get("status") or kind.split(".")[1], reason=reason, usage=response.get("usage"))
    elif kind == "response.failed":
        error = (event.get("response") or {}).get("error") or {}
        emit("error", code=error.get("code") or "response_failed", message=error.get("message") or "the response failed")
    elif kind == "error":
        emit("error", code=event.get("code") or "stream_error", message=event.get("message") or "stream error")


def status():
    record = load()
    signed_in = bool(record.get("refresh_token"))
    expires_in = int(record["expires_at"] - time.time()) if record.get("expires_at") else None
    emit("status", signed_in=signed_in, email=record.get("email"),
         plan=PLAN_SCOPE in (record.get("scopes") or []), expires_in=expires_in)


def logout():
    record = load()
    for key in ("access_token", "refresh_token", "id_token", "token_type", "expires_at", "scopes"):
        record.pop(key, None)
    if record:
        save(record)
    emit("signed_out")


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if command == "login":
            login("--no-browser" in sys.argv)
        elif command == "status":
            status()
        elif command == "models":
            models()
        elif command == "infer":
            infer()
        elif command == "logout":
            logout()
        else:
            raise Failure("usage", __doc__.strip().splitlines()[0])
    except Failure as failure:
        emit("error", code=failure.code, message=str(failure), relogin=failure.relogin)
        return 1
    except (OSError, ValueError, KeyError) as err:
        emit("error", code="local", message=f"{type(err).__name__}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
