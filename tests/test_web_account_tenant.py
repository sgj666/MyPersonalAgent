"""Teacher accounts: registration, login, and the tenant they pin a request to.

The console used to authenticate one shared password and then believe whatever
``agent_id`` the request named, so "isolated tenants" would have been a UI
convention. These tests drive a real HTTP server because the interesting part is
the contract between what a client presents (cookie, Bearer, query token) and
the Agent a handler ends up acting on -- not the shape of a helper in isolation.

Every path is pinned under ``tmp_path``: ``users.json`` lives at the shared root
(``state_dir.users_file``), the signing key under ``<shared>/system/web_secret``,
and each registered teacher's workspace under ``<instance>/agents/<id>``.
"""

import hmac
import hashlib
import json
import shutil
import secrets
import threading
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from types import SimpleNamespace
from wsgiref.simple_server import WSGIRequestHandler, make_server

import pytest

import web

from channel.web.api.account import (
    TOKEN_TTL_SECONDS,
    AccountLoginHandler,
    AccountLogoutHandler,
    AccountMeHandler,
    AccountRegisterHandler,
    _hash_password,
    create_account_token,
)
from channel.web.api.auth import AuthCheckHandler, AuthLoginHandler, AuthLogoutHandler
from channel.web.core import _common
from common import state_dir

CONSOLE_PASSWORD = "console-password"


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


class _ProbeHandler:
    """A protected endpoint reduced to the two questions that matter.

    ``/probe`` stands in for any ``/api`` route that starts with
    ``_require_auth``: which Agent does this request act on, and which workspace
    does ``state_dir`` resolve while it runs.
    """

    def GET(self):
        return self._answer(dict(web.input()))

    def POST(self):
        try:
            body = json.loads(web.data() or "{}")
        except ValueError:
            body = {}
        return self._answer(body if isinstance(body, dict) else {})

    @staticmethod
    def _answer(source):
        _common._require_auth()
        web.header("Content-Type", "application/json; charset=utf-8")
        return json.dumps({
            "status": "success",
            "agent_id": _common._scoped_agent_id(source),
            "request_agent_id": _common._request_agent_id(source),
            "state_root": str(state_dir.state_root()),
        }, ensure_ascii=False)


class _FakeRegistry:
    """The layout the admin service derives: default at the root, others under
    ``agents/<id>``. ``state_dir.shared_root()`` is the default's workspace, so
    this is also what puts ``users.json`` in the instance root."""

    default_agent_id = "default"

    def __init__(self, instance):
        self.instance = instance

    def get(self, agent_id=None, require_enabled=True):
        workspace = self.instance if not agent_id else self.instance / "agents" / agent_id
        return SimpleNamespace(id=agent_id or "default", workspace=str(workspace))


class _Client:
    """One browser: its own cookie jar, so two teachers never share a session."""

    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )

    def post(self, path, payload):
        return self._send("POST", path, json.dumps(payload).encode("utf-8"), "application/json")

    def get(self, path):
        return self._send("GET", path)

    def get_with_bearer(self, path, token):
        return self._send("GET", path, bearer=token)

    def _send(self, method, path, body=None, content_type=None, bearer=None):
        headers = {}
        if content_type:
            headers["Content-Type"] = content_type
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        request = urllib.request.Request(self.base + path, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or b"{}")
            except ValueError:
                return e.code, {}
        except (ConnectionResetError, ConnectionAbortedError) as e:
            # Say which call broke rather than surfacing a bare socket error: a
            # handler that answers without reading its POST body makes the
            # server close with RST, and this is how that shows up.
            raise AssertionError(f"{method} {path} lost its connection: {e}") from e



@pytest.fixture(scope="module")
def _server(tmp_path_factory):
    """One console for the whole module, with a throwaway instance root.

    One server rather than one per test: binding a fresh ephemeral port a dozen
    times per file is what makes a WSGI test flake with a reset connection, and
    nothing here needs a new socket to be isolated.

    The admin service resolves ``config.json`` and the instance root at call
    time, so pointing the data root at ``tmp_path`` keeps every Agent workspace,
    ``users.json`` and the signing key inside it.
    """
    root = tmp_path_factory.mktemp("teacher-accounts")
    instance = root / "instance"
    instance.mkdir()
    data_root = root / "data"
    data_root.mkdir()
    (data_root / "config.json").write_text(
        json.dumps({"agent_workspace": str(instance)}), encoding="utf-8"
    )

    patches = pytest.MonkeyPatch()
    patches.setenv("COW_DATA_DIR", str(data_root))
    # Legacy mode is still live underneath: the console password is set, and
    # whether it authenticates is exactly what account mode has to decide.
    patches.setattr(_common, "_get_web_password", lambda: CONSOLE_PASSWORD)
    import channel.web.api.auth as auth_module

    patches.setattr(auth_module, "_get_web_password", lambda: CONSOLE_PASSWORD)

    import agent.registry as registry_module

    patches.setattr(registry_module, "get_agent_registry", lambda: _FakeRegistry(instance))

    app = web.application(
        (
            "/api/account/register", AccountRegisterHandler,
            "/api/account/login", AccountLoginHandler,
            "/api/account/logout", AccountLogoutHandler,
            "/api/account/me", AccountMeHandler,
            "/auth/login", AuthLoginHandler,
            "/auth/logout", AuthLogoutHandler,
            "/auth/check", AuthCheckHandler,
            "/probe", _ProbeHandler,
        ),
        {},
    )
    server = make_server("127.0.0.1", 0, app.wsgifunc(), handler_class=_QuietHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield SimpleNamespace(base=f"http://127.0.0.1:{server.server_address[1]}", instance=instance)
    finally:
        server.shutdown()
        server.server_close()
        patches.undo()


@pytest.fixture
def console(_server):
    """The console with no accounts and no Agent workspaces: every test starts
    from the state of a fresh install, which is also the legacy-mode state."""
    instance = _server.instance
    for child in list(instance.iterdir()):
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()

    from channel.web.api.auth import _login_limiter

    _login_limiter.reset("console-local")
    base = _server.base
    return SimpleNamespace(
        base=base,
        instance=instance,
        client=_Client,
        register=lambda username, password="pass-1234", name=None: _register(
            base, username, password, name
        ),
        workspace=lambda agent_id: instance / "agents" / agent_id,
    )


def _register(base, username, password="pass-1234", name=None):
    payload = {"username": username, "password": password}
    if name is not None:
        payload["name"] = name
    status, body = _Client(base).post("/api/account/register", payload)
    assert status == 200 and body.get("status") == "success", body
    return body


def _users(instance):
    return json.loads((instance / "users.json").read_text(encoding="utf-8"))


def test_registration_creates_tenant_with_private_assets(console):
    user = console.register("teacher_a", name="王老师")["user"]

    assert user["username"] == "teacher_a"
    assert user["name"] == "王老师"
    assert user["agent_id"].startswith("t_")
    assert user["id"] and user["id"] != user["agent_id"]

    store = _users(console.instance)
    assert store["version"] == 1
    assert len(store["users"]) == 1
    record = store["users"][0]
    assert record["agent_id"] == user["agent_id"]
    assert record["password_hash"] != "pass-1234"
    assert "pass-1234" not in json.dumps(store)
    # Portable on purpose: ``hashlib.scrypt`` is missing from OpenSSL builds
    # without it, and the iteration count travels with the hash so it can be
    # raised without invalidating accounts.
    scheme, iterations, digest = record["password_hash"].split("$")
    assert scheme == "pbkdf2-sha256"
    assert int(iterations) >= 200_000
    assert len(bytes.fromhex(digest)) == 32
    assert len(bytes.fromhex(record["salt"])) == 16
    assert record["created_at"].endswith("Z")

    workspace = console.workspace(user["agent_id"])
    for name in ("knowledge", "skills"):
        private = workspace / name
        assert private.is_dir(), f"{name}/ must exist or state_dir falls back to shared"
        assert not private.is_symlink()

    assert (console.instance / "users.json").stat().st_mode & 0o777 == 0o600
    secret = console.instance / "system" / "web_secret"
    assert secret.is_file()
    assert secret.stat().st_mode & 0o777 == 0o600


def test_duplicate_username_is_rejected(console):
    console.register("teacher_a")
    before = _users(console.instance)["users"]

    status, body = console.client(console.base).post(
        "/api/account/register", {"username": "teacher_a", "password": "another-pass"}
    )
    assert status == 200
    assert body["status"] == "error" and body["reason"] == "username_taken"
    assert "token" not in body

    # Case only: two accounts that differ by case would be one name to a teacher.
    status, body = console.client(console.base).post(
        "/api/account/register", {"username": "TEACHER_A", "password": "another-pass"}
    )
    assert body["reason"] == "username_taken"
    assert len(_users(console.instance)["users"]) == len(before) == 1


def test_wrong_password_is_rejected(console):
    console.register("teacher_a", password="pass-1234")
    client = console.client(console.base)

    status, body = client.post("/api/account/login",
                               {"username": "teacher_a", "password": "not-the-pass"})
    assert status == 200
    assert body["status"] == "error" and body["reason"] == "invalid_credentials"
    assert "token" not in body

    # An unknown username must answer the same way, so this is not an oracle.
    status, body = client.post("/api/account/login",
                               {"username": "nobody", "password": "not-the-pass"})
    assert body["reason"] == "invalid_credentials"

    status, body = client.post("/api/account/login",
                               {"username": "teacher_a", "password": "pass-1234"})
    assert body["status"] == "success" and body["token"]


def test_stored_hash_carries_its_own_cost(console):
    """A record written with a different cost still verifies.

    That is the point of putting the iteration count in the hash: raising it
    later must not lock out every existing account.
    """
    salt = secrets.token_bytes(16)
    record = {
        "id": "legacy01",
        "username": "legacy_cost",
        "name": "Legacy",
        "agent_id": "t_legacy01",
        "password_hash": _hash_password("pass-1234", salt, iterations=120_000),
        "salt": salt.hex(),
        "created_at": "2026-01-01T00:00:00Z",
    }
    store = {"version": 1, "users": [record]}
    (console.instance / "users.json").write_text(json.dumps(store), encoding="utf-8")

    client = console.client(console.base)
    status, body = client.post("/api/account/login",
                               {"username": "legacy_cost", "password": "pass-1234"})
    assert body["status"] == "success" and body["token"]

    # An unknown scheme is refused, not guessed at.
    record["password_hash"] = "md5$1$" + "00" * 16
    store["users"] = [record]
    (console.instance / "users.json").write_text(json.dumps(store), encoding="utf-8")
    status, body = client.post("/api/account/login",
                               {"username": "legacy_cost", "password": "pass-1234"})
    assert body["reason"] == "invalid_credentials"


def test_hashing_never_reaches_for_scrypt(console, monkeypatch):
    """``hashlib.scrypt`` is absent from LibreSSL builds (this machine's 3.9).

    Registration and login have to work there, so nothing on the password path
    may call it.
    """
    monkeypatch.delattr(hashlib, "scrypt", raising=False)

    console.register("teacher_no_scrypt", password="pass-1234")
    status, body = console.client(console.base).post(
        "/api/account/login", {"username": "teacher_no_scrypt", "password": "pass-1234"}
    )
    assert body["status"] == "success" and body["token"]


def test_expired_token_is_rejected(console):
    console.register("teacher_a", password="pass-1234")
    record = _users(console.instance)["users"][0]
    expired = create_account_token(record, now=time.time() - TOKEN_TTL_SECONDS - 5)

    client = console.client(console.base)
    status, body = client.get(f"/api/account/me?token={expired}")
    assert status == 401

    status, _ = client.get(f"/probe?token={expired}")
    assert status == 401

    # Same token, unexpired: the only difference is the clock.
    fresh = create_account_token(record)
    status, body = client.get(f"/api/account/me?token={fresh}")
    assert status == 200 and body["user"]["username"] == "teacher_a"

    # And a tampered signature is not a session either.
    tampered = fresh[:-4] + ("AAAA" if not fresh.endswith("AAAA") else "BBBB")
    status, _ = client.get_with_bearer("/probe", tampered)
    assert status == 401


def test_teacher_cannot_reach_another_agent(console):
    teacher_a = console.register("teacher_a", name="A")["user"]
    teacher_b = console.register("teacher_b", name="B")["user"]
    assert teacher_a["agent_id"] != teacher_b["agent_id"]

    client_a = console.client(console.base)
    status, body = client_a.post("/api/account/login",
                                 {"username": "teacher_a", "password": "pass-1234"})
    assert status == 200 and body["status"] == "success"

    workspace_a = str(console.workspace(teacher_a["agent_id"]))
    workspace_b = str(console.workspace(teacher_b["agent_id"]))
    assert workspace_a != workspace_b

    # The attack: name the other teacher's Agent in the query string.
    status, body = client_a.get(f"/probe?agent_id={teacher_b['agent_id']}")
    assert status == 200
    assert body["agent_id"] == teacher_a["agent_id"]
    assert body["request_agent_id"] == teacher_a["agent_id"]
    assert body["state_root"] == workspace_a
    assert body["state_root"] != workspace_b

    # Same via a JSON body, which is how most console endpoints take input.
    status, body = client_a.post("/probe", {"agent_id": teacher_b["agent_id"]})
    assert status == 200
    assert body["agent_id"] == teacher_a["agent_id"]
    assert body["state_root"] == workspace_a

    # The other teacher still lands in their own workspace.
    client_b = console.client(console.base)
    status, body = client_b.post("/api/account/login",
                                 {"username": "teacher_b", "password": "pass-1234"})
    assert body["status"] == "success"
    status, body = client_b.get(f"/probe?agent_id={teacher_a['agent_id']}")
    assert body["agent_id"] == teacher_b["agent_id"]
    assert body["state_root"] == workspace_b


def test_anonymous_request_after_a_session_gets_no_stale_tenant(console):
    teacher_a = console.register("teacher_a")["user"]
    client_a = console.client(console.base)
    assert client_a.post("/api/account/login",
                         {"username": "teacher_a", "password": "pass-1234"})[1]["status"] == "success"
    assert client_a.get("/probe")[1]["state_root"] == str(console.workspace(teacher_a["agent_id"]))

    # A request with no credential must not inherit the binding left on the
    # server thread by the previous one.
    status, _ = console.client(console.base).get("/probe")
    assert status == 401


def test_account_logout_drops_the_session(console):
    console.register("teacher_a")
    client = console.client(console.base)
    assert client.post("/api/account/login",
                       {"username": "teacher_a", "password": "pass-1234"})[1]["status"] == "success"
    assert client.get("/probe")[0] == 200

    status, body = client.post("/api/account/logout", {})
    assert status == 200 and body["status"] == "success"
    assert client.get("/probe")[0] == 401


def test_me_reports_the_signed_in_teacher(console):
    user = console.register("teacher_a", name="王老师")["user"]
    client = console.client(console.base)
    client.post("/api/account/login", {"username": "teacher_a", "password": "pass-1234"})

    status, body = client.get("/api/account/me")
    assert status == 200 and body["account_mode"] is True
    assert body["user"] == user


def test_legacy_console_password_still_authenticates(console):
    """No users.json: the console behaves exactly as it did before accounts."""
    assert not (console.instance / "users.json").exists()

    client = console.client(console.base)
    assert client.get("/probe")[0] == 401

    status, body = client.post("/auth/login", {"password": "wrong"})
    assert body["status"] == "error" and body["reason"] == "wrong_password"

    status, body = client.post("/auth/login", {"password": CONSOLE_PASSWORD})
    assert status == 200 and body["status"] == "success" and body["token"]

    status, body = client.get("/probe")
    assert status == 200
    assert body["state_root"] == str(console.instance)
    # Legacy mode still lets the client name an Agent; that is the behaviour
    # account mode replaces, not something this change takes away.
    status, body = client.get("/probe?agent_id=helper")
    assert body["agent_id"] == "helper"

    status, body = client.get("/auth/check")
    # No accounts: the answer is exactly what a single-password install has
    # always given, so older clients see nothing new.
    assert "account_mode" not in body and body["authenticated"] is True


def test_account_mode_ignores_the_console_password(console):
    console.register("teacher_a")
    client = console.client(console.base)

    status, body = client.post("/auth/login", {"password": CONSOLE_PASSWORD})
    assert body["status"] == "error" and body["reason"] == "account_mode"

    # A legacy token is signed with the password and names no tenant, so it must
    # not open a request that would then fall back to the default Agent.
    ts_hex = format(int(time.time()), "x")
    legacy = f"{ts_hex}." + hmac.new(
        CONSOLE_PASSWORD.encode(), ts_hex.encode(), hashlib.sha256
    ).hexdigest()
    assert client.get_with_bearer("/probe", legacy)[0] == 401

    status, body = client.get("/auth/check")
    assert status == 200
    assert body["account_mode"] is True and body["authenticated"] is False
