"""The OpenAI side of the openai-models Claude Code mod: Sign in with ChatGPT, and inference on the plan.

  gpt.py login [--no-browser]   sign in in the browser (OAuth with PKCE, a loopback redirect)
  gpt.py status                 who is signed in; never prints a token
  gpt.py models                 the models the signed-in account can use
  gpt.py infer                  one streamed /v1/responses request, its body read from stdin
  gpt.py logout                 forget the tokens (the issued client id is kept for the next sign-in)
  gpt.py schemas [--from F] [--out F] [--plugin DIR]
                                Claude Code's tool argument schemas, parsed from the types file
                                its plugin tooling writes, as JSON

Every command prints one JSON object per line on stdout. Tokens live only in the
credentials file, written atomically and owner-only, and are never printed.

This follows OpenAI's "token sharing for open-source and local apps":
https://developers.openai.com/siwc/token-sharing-open-source
"""
import base64
import glob
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import socketserver
import subprocess
import sys
import tempfile
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
ISSUER = AUTH  # https://auth.openai.com, as its OpenID configuration names itself
RESOURCE = "https://api.openai.com/v1"
HOME = os.environ.get("CLAUDE_GPT_HOME") or os.path.join(os.path.expanduser("~"), ".config", "claude-openai-models")
CREDENTIALS = os.path.join(HOME, "credentials.json")
LOCK = os.path.join(HOME, "refresh.lock")
SCHEMAS = os.path.join(HOME, "tool-schemas.json")

# Codes after which only a new sign-in helps (Errors and recovery).
RELOGIN = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
           "refresh_token_invalidated", "refresh_token_reused"}

# The DER prefix of a SHA-256 DigestInfo, for RSASSA-PKCS1-v1_5 signatures (RFC 8017, 9.2).
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


class Failure(Exception):
    def __init__(self, code, message, relogin=False, param=None):
        super().__init__(message)
        self.code, self.relogin, self.param = code, relogin, param


def emit(kind, **fields):
    sys.stdout.write(json.dumps({"type": kind, **fields}) + "\n")
    sys.stdout.flush()


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load():
    try:
        with open(CREDENTIALS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def protect(path):
    """Owner-only: 0700/0600 on Unix; on Windows the folder's inherited ACL is cut to the user alone."""
    if os.name != "nt":
        return
    user = os.environ.get("USERNAME")
    if user:
        subprocess.run(["icacls", path, "/inheritance:r", "/grant:r", f"{user}:(OI)(CI)F"],
                       capture_output=True, check=False)


def save(record):
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    protect(HOME)  # idempotent; also covers a folder made before this check existed
    temp = CREDENTIALS + f".{os.getpid()}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)
    os.replace(temp, CREDENTIALS)


def host_id(record):
    """A stable, opaque id for this machine, made once (urn:uuid, as the docs allow)."""
    return record.get("ext_agent_host_id") or f"urn:uuid:{uuid.uuid4()}"


def read_error(err):
    try:
        return json.loads(err.read().decode("utf-8"))
    except Exception:
        return {"detail": err.reason}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


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


def store_tokens(record, tokens):
    scope = tokens.get("scope")
    record.update({
        "id_token": tokens.get("id_token", record.get("id_token")),
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", record.get("refresh_token")),
        "token_type": tokens.get("token_type", "Bearer"),
        "expires_at": int(time.time()) + int(tokens.get("expires_in", 3600)),
        "scopes": scope.split() if isinstance(scope, str) else scope or record.get("scopes") or [],
        "saved_at": int(time.time()),
    })


def verify_id_token(token, client_id, nonce):
    """The ID token's claims, once its RS256 signature verifies against OpenAI's published keys
    and its issuer, audience, expiry and nonce are this sign-in's."""
    try:
        header_b64, payload_b64, signature_b64 = token.split(".")
        header = json.loads(b64url_decode(header_b64))
        claims = json.loads(b64url_decode(payload_b64))
    except ValueError:
        raise Failure("bad_id_token", "the ID token is malformed; nothing was saved")
    if header.get("alg") != "RS256":
        raise Failure("bad_id_token", f"the ID token is signed with {header.get('alg')}, not RS256; nothing was saved")
    keys = get_json(f"{AUTH}/.well-known/jwks.json").get("keys", [])
    key = next((k for k in keys if k.get("kty") == "RSA" and k.get("kid") == header.get("kid")), None)
    if key is None:
        raise Failure("bad_id_token", "the ID token's key is not among OpenAI's published keys; nothing was saved")
    n = int.from_bytes(b64url_decode(key["n"]), "big")
    e = int.from_bytes(b64url_decode(key["e"]), "big")
    size = (n.bit_length() + 7) // 8
    digest = hashlib.sha256(f"{header_b64}.{payload_b64}".encode("ascii")).digest()
    expected = b"\x00\x01" + b"\xff" * (size - len(SHA256_DIGEST_INFO) - len(digest) - 3) + b"\x00" + SHA256_DIGEST_INFO + digest
    signature = int.from_bytes(b64url_decode(signature_b64), "big")
    if signature >= n or not hmac.compare_digest(pow(signature, e, n).to_bytes(size, "big"), expected):
        raise Failure("bad_id_token", "the ID token's signature does not verify; nothing was saved")
    audience = claims.get("aud")
    if claims.get("iss") != ISSUER:
        raise Failure("bad_id_token", f"the ID token was issued by {claims.get('iss')}, not {ISSUER}; nothing was saved")
    if client_id not in (audience if isinstance(audience, list) else [audience]):
        raise Failure("bad_id_token", "the ID token was issued to another client; nothing was saved")
    if claims.get("nonce") != nonce or claims.get("exp", 0) < time.time() - 60:
        raise Failure("bad_id_token", "the ID token failed its nonce or expiry check; nothing was saved")
    return claims


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
    elif record.get("email"):
        # No id_token_hint: this URL is shown and logged, and a token has no place there.
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
    claims = verify_id_token(tokens["id_token"], client_id, nonce)
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
            for key in ("access_token", "refresh_token", "id_token", "token_type", "expires_at"):
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
        return urllib.request.urlopen(request, timeout=300)
    except urllib.error.HTTPError as err:
        payload = read_error(err)
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        code = error.get("code") or f"http_{err.code}"
        message = error.get("message") or payload.get("detail") or err.reason
        raise Failure(code, f"{message} (HTTP {err.code})", relogin=err.code == 401, param=error.get("param"))


def models():
    with api("GET", "/models") as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("models") or payload.get("data") or []
    listed = [{"slug": m.get("slug") or m.get("id"), "name": m.get("display_name") or m.get("slug") or m.get("id")}
              for m in rows if m.get("visibility", "list") == "list"]
    emit("models", models=[m for m in listed if m["slug"]])


def text_only(content):
    """Content parts as plain text, images and files named instead of sent."""
    if isinstance(content, str):
        return content
    words = []
    for part in content or []:
        kind = part.get("type")
        words.append(part.get("text", "") if kind in ("input_text", "output_text")
                     else "[image omitted]" if kind == "input_image" else "[file omitted]")
    return "\n".join(w for w in words if w)


def simplified(body):
    """The body with every function output as text and no files: what a model without those takes."""
    items = []
    for item in body.get("input", []):
        if item.get("type") == "function_call_output" and not isinstance(item.get("output"), str):
            item = {**item, "output": text_only(item["output"])}
        elif isinstance(item.get("content"), list) and any(p.get("type") == "input_file" for p in item["content"]):
            item = {**item, "content": [p if p.get("type") != "input_file" else {"type": "input_text", "text": "[file omitted]"}
                                        for p in item["content"]]}
        items.append(item)
    return {**body, "input": items}


def infer():
    sys.stdin.reconfigure(encoding="utf-8")
    body = json.loads(sys.stdin.read())
    body.update({"store": False, "stream": True})
    # A model that refuses an option the mod sent gets the request again without it, at most twice.
    for _ in range(3):
        try:
            return stream_response(body)
        except Failure as failure:
            if failure.code != "subscription_sharing_unsupported_capability" and not str(failure).startswith("Unsupported"):
                raise
            where = f"{failure.param or ''} {failure}".lower()
            if ("reasoning" in where or "include" in where) and ("reasoning" in body or "include" in body):
                emit("notice", message=f"{body.get('model')} takes no reasoning settings here; sent without them")
                body = {k: v for k, v in body.items() if k not in ("reasoning", "include")}
            elif body != simplified(body):
                emit("notice", message=f"{body.get('model')} takes no images or files here; sent as text")
                body = simplified(body)
            else:
                raise


def stream_response(body):
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
    elif kind == "response.output_item.done" and event["item"].get("type") == "reasoning":
        emit("reasoning", item=event["item"])
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


# --- tool schemas ---------------------------------------------------------------------------------
# Claude Code's plugin tooling writes a TypeScript types file whose `interface BuiltinToolInputs`
# holds every built-in tool's arguments, generated from the tools' own input schemas. A mod is not
# handed those schemas at run time, so they are read back from that file into JSON Schema.

TOKEN = re.compile(r"""
    (?P<doc>/\*\*.*?\*/)
  | (?P<comment>//[^\n]*|/\*.*?\*/)
  | (?P<str>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')
  | (?P<num>-?\d+(?:\.\d+)?)
  | (?P<ident>[A-Za-z_$][A-Za-z0-9_$]*)
  | (?P<punct>[{}()\[\]<>|:?;,&])
  | (?P<ws>\s+)
""", re.S | re.X)


def tokens(text):
    out, at = [], 0
    while at < len(text):
        m = TOKEN.match(text, at)
        if not m:
            raise ValueError(f"cannot read the types file at {text[at:at + 40]!r}")
        at = m.end()
        if m.lastgroup not in ("ws", "comment"):
            out.append((m.lastgroup, m.group()))
    return out


def doc_text(doc):
    lines = [re.sub(r"^\s*\*\s?", "", line) for line in doc[3:-2].splitlines()]
    text = " ".join(line.strip() for line in lines if line.strip() and not line.strip().startswith("@"))
    return text.strip()


class SchemaParser:
    def __init__(self, toks):
        self.toks, self.at = toks, 0

    def peek(self, offset=0):
        i = self.at + offset
        return self.toks[i] if i < len(self.toks) else (None, None)

    def take(self, value=None):
        tok = self.peek()
        if value is not None and tok[1] != value:
            raise ValueError(f"expected {value!r}, found {tok[1]!r}")
        self.at += 1
        return tok

    def object(self):
        self.take("{")
        properties, required, doc = {}, [], None
        while True:
            kind, value = self.peek()
            if value in (";", ","):
                self.take()
                continue
            if value == "}":
                self.take()
                break
            if kind == "doc":
                doc = doc_text(self.take()[1])
                continue
            if value == "readonly":
                self.take()
                continue
            name = json.loads(value) if kind == "str" else value
            self.take()
            optional = self.peek()[1] == "?"
            if optional:
                self.take()
            self.take(":")
            schema = self.type()
            if doc:
                schema = {**schema, "description": doc}
            properties[name] = schema
            if not optional:
                required.append(name)
            doc = None
        if not properties:
            return {"type": "object"}
        return {"type": "object", "properties": properties, "required": required}

    def type(self):
        if self.peek()[1] == "|":
            self.take()
        options = [self.intersection()]
        while self.peek()[1] == "|":
            self.take()
            options.append(self.intersection())
        return union(options)

    def intersection(self):
        parts = [self.postfix()]
        while self.peek()[1] == "&":
            self.take()
            parts.append(self.postfix())
        parts = [p for p in parts if p]  # `unknown` adds nothing
        return parts[0] if len(parts) == 1 else {"allOf": parts} if parts else {}

    def postfix(self):
        schema = self.primary()
        while self.peek()[1] == "[" and self.peek(1)[1] == "]":
            self.take()
            self.take()
            schema = {"type": "array", "items": schema}
        return schema

    def primary(self):
        kind, value = self.peek()
        if value == "{":
            return self.object()
        if value == "(":
            self.take()
            schema = self.type()
            self.take(")")
            return schema
        if kind == "str":
            self.take()
            return {"const": json.loads(value) if value.startswith('"') else value[1:-1]}
        if kind == "num":
            self.take()
            return {"const": float(value) if "." in value else int(value)}
        if kind != "ident":
            raise ValueError(f"unexpected {value!r} in a type")
        self.take()
        if value == "readonly":
            return self.primary()
        if value in ("Array", "ReadonlyArray", "Record"):
            self.take("<")
            first = self.type()
            second = None
            if self.peek()[1] == ",":
                self.take()
                second = self.type()
            self.take(">")
            return {"type": "object", "additionalProperties": second or {}} if value == "Record" else {"type": "array", "items": first}
        return {"string": {"type": "string"}, "number": {"type": "number"}, "boolean": {"type": "boolean"},
                "null": {"type": "null"}, "true": {"const": True}, "false": {"const": False},
                "object": {"type": "object"}}.get(value, {})


def union(options):
    options = [o for o in options if o != {"type": "null"}] + [o for o in options if o == {"type": "null"}]
    if len(options) == 1:
        return options[0]
    consts = [o["const"] for o in options if set(o) == {"const"}]
    if len(consts) == len(options) and all(isinstance(c, str) for c in consts):
        return {"type": "string", "enum": consts}
    if len(consts) == len(options) and all(isinstance(c, bool) for c in consts):
        return {"type": "boolean"}
    return {"anyOf": options}


def parse_tool_inputs(text):
    """Tool name → JSON Schema of its arguments, from the `interface BuiltinToolInputs` in `text`."""
    # The generated map is the last declaration of the interface; earlier ones are the API's own
    # empty one and its documentation.
    start = text.rfind("interface BuiltinToolInputs {")
    if start < 0:
        raise ValueError("no `interface BuiltinToolInputs` in the types file")
    toks = tokens(text[text.index("{", start):])
    parser = SchemaParser(toks)
    parser.take("{")
    schemas = {}
    while parser.peek()[1] != "}":
        kind, value = parser.peek()
        if kind == "doc" or value in (";", ","):
            parser.take()
            continue
        name = json.loads(value) if kind == "str" else value
        parser.take()
        parser.take(":")
        schemas[name] = parser.type()
        # The map's own closing brace ends a short read; anything after it is another interface.
    return schemas


def types_files(plugin_dir):
    """Candidate types files, best first: the plugin's own, then the newest the plugin tooling wrote."""
    found = []
    if plugin_dir:
        found.append(os.path.join(plugin_dir, ".claude-plugin", "types", "claude-code-tools", "index.d.ts"))
    pattern = os.path.join(tempfile.gettempdir(), "claude", "bundled-skills", "*", "*", "plugin-authoring", "types", "claude-code.d.ts")
    def version(path):
        parts = path.replace("\\", "/").split("/bundled-skills/")[1].split("/")[0]
        return tuple(int(p) if p.isdigit() else 0 for p in parts.split("."))
    found += sorted(glob.glob(pattern), key=lambda p: (version(p), os.path.getmtime(p)), reverse=True)
    return [p for p in found if os.path.isfile(p)]


def schemas(args):
    source = args[args.index("--from") + 1] if "--from" in args else None
    out = args[args.index("--out") + 1] if "--out" in args else SCHEMAS
    plugin_dir = args[args.index("--plugin") + 1] if "--plugin" in args else None
    candidates = [source] if source else types_files(plugin_dir)
    if not candidates:
        raise Failure("no_types", "no Claude Code types file found; the mod keeps the schemas it shipped with")
    with open(candidates[0], encoding="utf-8") as f:
        parsed = parse_tool_inputs(f.read())
    record = {"source": candidates[0], "generated_at": int(time.time()), "schemas": parsed}
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    temp = out + f".{os.getpid()}.tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=1)
    os.replace(temp, out)
    emit("schemas", source=candidates[0], tools=len(parsed), out=out)


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
        elif command == "schemas":
            schemas(sys.argv[2:])
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
