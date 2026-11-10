"""Teacher accounts: self-registration, login, and the token that scopes a request.

One account owns one Agent, and that Agent's workspace is the teacher's tenant
(``common/state_dir.py``). The account layer exists to answer "which Agent is
this request for" from something the client cannot choose: the console's legacy
token only says "someone knew the password", so every request was free to name
any ``agent_id`` in its query string.

``users.json`` is the switch. It has always been *the* instance's account store
(``state_dir.users_file``); if it is absent the console keeps the single
password behaviour it had before this module existed, and nothing here is
consulted.

Token format is ``<uid>.<agent_id>.<exp>.<sig>``: the first three joined by dots
are the signed message, ``sig`` is HMAC-SHA256 base64url (no padding) under
``state_dir.web_secret_file()``. The key is separate from ``web_password`` so
rotating the console password does not sign every teacher out.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import web

from channel.web.api.auth import _limiter_scope, _login_limiter
from channel.web.core._common import (
    _account_identity,
    _client_ip,
    _discard_request_body,
    _presented_token,
    _require_auth,
)
from common import state_dir
from common.log import logger
from common.runtime_identity import RuntimeIdentity
from common.utils import constant_time_equals

#: Where the console keeps its session token. The same cookie the legacy login
#: sets, because ``_check_auth`` reads one credential whichever mode is live.
COOKIE_NAME = "cow_auth_token"
TOKEN_TTL_SECONDS = 7 * 86400

#: ``hashlib.scrypt`` is the memory-hard choice, but it is absent from builds
#: linked against LibreSSL (this project is developed on macOS, whose system
#: Python is one of them), so the store is written with PBKDF2-HMAC-SHA256:
#: available in every CPython, 200k iterations is a deliberate cost, and the
#: iteration count travels inside the hash so it can be raised later without
#: invalidating existing accounts.
PBKDF2_SCHEME = "pbkdf2-sha256"
PBKDF2_ITERATIONS = 200_000
#: A record from a tampered store must not be able to ask for an unbounded
#: derivation, which would hang the login handler.
MAX_PBKDF2_ITERATIONS = 2_000_000
SALT_BYTES = 16
MIN_PASSWORD_LENGTH = 6
MAX_PASSWORD_LENGTH = 200
MIN_USERNAME_LENGTH = 3
MAX_USERNAME_LENGTH = 64

# Serialises read-modify-write of users.json. One console process owns the file,
# so a thread lock is the whole story; registration also creates a workspace,
# which must not interleave with another registration for the same username.
_store_lock = threading.RLock()


class AccountStoreError(RuntimeError):
    """The account store or its signing key is unusable."""


# --- Store -------------------------------------------------------------------


def accounts_enabled() -> bool:
    """True when this instance has teacher accounts (``users.json`` exists)."""
    return state_dir.users_file().is_file()


def _load_users() -> dict:
    path = state_dir.users_file()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"version": 1, "users": []}
    except OSError as e:
        raise AccountStoreError(f"cannot read {path}: {e}") from e
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise AccountStoreError(f"{path} is not valid JSON: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("users"), list):
        raise AccountStoreError(f"{path} does not hold a user list")
    data["version"] = 1
    return data


def _save_users(data: dict) -> None:
    from common.atomic_write import write_json_atomic

    path = state_dir.users_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, data)
    try:
        os.chmod(path, 0o600)
    except OSError as e:
        logger.warning(f"[Account] could not restrict permissions on {path}: {e}")


def find_user(username: str = None, user_id: str = None) -> Optional[dict]:
    """The user matching ``username`` (case-insensitive) or ``user_id``."""
    wanted = (username or "").strip().casefold() if username is not None else None
    for user in _load_users()["users"]:
        if not isinstance(user, dict):
            continue
        if wanted is not None and str(user.get("username", "")).casefold() == wanted:
            return user
        if user_id is not None and user.get("id") == user_id:
            return user
    return None


# --- Passwords ---------------------------------------------------------------


def _derive(password: str, salt: bytes, iterations: int) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations, dklen=32
    ).hex()


def _hash_password(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> str:
    """``pbkdf2-sha256$<iterations>$<hex>``.

    The parameters live in the value rather than in a separate field so a later
    cost bump verifies old records with their own count while new ones get the
    higher one.
    """
    return f"{PBKDF2_SCHEME}${iterations}${_derive(password, salt, iterations)}"


def _new_salt() -> bytes:
    return secrets.token_bytes(SALT_BYTES)


def _verify_password(user: dict, password: str) -> bool:
    try:
        salt = bytes.fromhex(str(user.get("salt") or ""))
    except ValueError:
        return False
    if len(salt) != SALT_BYTES:
        return False
    scheme, _, rest = str(user.get("password_hash") or "").partition("$")
    if scheme != PBKDF2_SCHEME:
        return False
    iterations_text, _, digest = rest.partition("$")
    try:
        iterations = int(iterations_text)
    except ValueError:
        return False
    if not 1 < iterations <= MAX_PBKDF2_ITERATIONS:
        return False
    return constant_time_equals(_derive(password, salt, iterations), digest)


#: A derivation of a password nobody has, so an unknown username costs the same
#: PBKDF2 pass as a known one and the response time does not enumerate accounts.
_DUMMY_SALT = bytes(SALT_BYTES)


def _burn_password_check(password: str) -> None:
    _derive(password[:MAX_PASSWORD_LENGTH], _DUMMY_SALT, PBKDF2_ITERATIONS)


# --- Token -------------------------------------------------------------------


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _web_secret() -> bytes:
    """The signing key, created 0600 on first use and read on every later call.

    Not cached in memory: the secret is one small file, and a cache would keep a
    stale key alive after an operator rotates it.
    """
    path = state_dir.web_secret_file()
    try:
        stored = path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        stored = ""
    except OSError as e:
        raise AccountStoreError(f"cannot read {path}: {e}") from e
    if stored:
        try:
            return bytes.fromhex(stored)
        except ValueError as e:
            raise AccountStoreError(f"{path} is not a hex key: {e}") from e

    path.parent.mkdir(parents=True, exist_ok=True)
    generated = secrets.token_bytes(32)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another thread or process created it between the read and here.
        try:
            return bytes.fromhex(path.read_text(encoding="ascii").strip())
        except (OSError, ValueError) as e:
            raise AccountStoreError(f"{path} is unusable: {e}") from e
    try:
        os.write(fd, generated.hex().encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return generated


def _sign(payload: str) -> str:
    return _b64(hmac.new(_web_secret(), payload.encode("utf-8", "surrogatepass"), hashlib.sha256).digest())


def create_account_token(user: dict, now: float = None) -> str:
    exp = int((now if now is not None else time.time()) + TOKEN_TTL_SECONDS)
    payload = f"{user['id']}.{user['agent_id']}.{exp}"
    return f"{payload}.{_sign(payload)}"


def read_account_token(token: str) -> Optional[dict]:
    """The verified claims of ``token``, or None if it is forged or expired."""
    if not token:
        return None
    parts = token.split(".")
    if len(parts) < 4:
        return None
    sig = parts[-1]
    payload = ".".join(parts[:-1])
    try:
        expected = _sign(payload)
    except AccountStoreError as e:
        logger.warning(f"[Account] session token rejected: {e}")
        return None
    if not constant_time_equals(sig, expected):
        return None
    uid, _, rest = payload.partition(".")
    agent_id, _, exp_text = rest.rpartition(".")
    if not uid or not agent_id:
        return None
    try:
        exp = int(exp_text)
    except ValueError:
        return None
    if exp <= time.time():
        return None
    return {"uid": uid, "agent_id": agent_id, "exp": exp}


def verify_account_token(token: str) -> Optional[RuntimeIdentity]:
    """The identity a valid token stands for, or None.

    ``_check_auth``/``_require_auth`` in ``_common`` are the only callers: a
    token is the one thing a request may present that names its tenant.
    """
    claims = read_account_token(token)
    if claims is None:
        return None
    return RuntimeIdentity(agent_id=claims["agent_id"])


# --- Registration ------------------------------------------------------------


def _validated_username(raw) -> str:
    username = str(raw or "").strip()
    if not MIN_USERNAME_LENGTH <= len(username) <= MAX_USERNAME_LENGTH:
        raise ValueError(f"username must be {MIN_USERNAME_LENGTH}-{MAX_USERNAME_LENGTH} characters")
    if any(ch.isspace() or ord(ch) < 32 for ch in username):
        raise ValueError("username must not contain whitespace")
    return username


def _validated_password(raw) -> str:
    password = str(raw or "")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"password must be at most {MAX_PASSWORD_LENGTH} characters")
    return password


def _create_teacher_agent(agent_id: str, name: str) -> str:
    """Create the Agent that is this teacher's workspace, and return its path.

    ``knowledge_mode``/``skill_mode`` ask the admin service for private copies,
    and the two directories are then created explicitly: ``state_dir`` decides
    "shared or own" by *presence*, so a missing ``knowledge/`` silently falls
    back to the shared library and one teacher's textbook would answer another
    teacher's question.
    """
    # Imported here rather than at module scope: the web console loads this
    # module before the configuration it would read, and the service resolves
    # config.json at call time.
    from agent.admin import get_agent_admin_service

    profile = get_agent_admin_service().create_agent(
        agent_id=agent_id,
        name=name,
        knowledge_mode="own",
        skill_mode="own",
    )
    workspace = Path(profile["workspace"])
    for sub in ("knowledge", "skills"):
        (workspace / sub).mkdir(parents=True, exist_ok=True)
    return str(workspace)


def _public_user(user: dict) -> dict:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "name": user.get("name"),
        "agent_id": user.get("agent_id"),
    }


def _json_response(payload: dict) -> str:
    web.header("Content-Type", "application/json; charset=utf-8")
    return json.dumps(payload, ensure_ascii=False)


def _request_body() -> dict:
    try:
        data = json.loads(web.data())
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _set_session_cookie(token: str) -> None:
    web.setcookie(COOKIE_NAME, token, expires=TOKEN_TTL_SECONDS,
                  path="/", httponly=True, samesite="Lax")


def _unauthorized() -> None:
    web.header("Content-Type", "application/json; charset=utf-8")
    raise web.HTTPError(
        "401 Unauthorized",
        {"Content-Type": "application/json; charset=utf-8"},
        json.dumps({"status": "error", "message": "Unauthorized"}),
    )


# --- Handlers ----------------------------------------------------------------


class AccountRegisterHandler:
    """Create an account, its Agent, and the session for it.

    Open by design: this endpoint is how the first account comes into being on a
    fresh instance, and how a teacher adds a colleague. It creates a new tenant
    with an empty workspace; it never grants access to an existing one.
    """

    def POST(self):
        body = _request_body()
        try:
            username = _validated_username(body.get("username"))
            password = _validated_password(body.get("password"))
        except ValueError as e:
            return _json_response({"status": "error", "reason": "invalid", "message": str(e)})
        name = str(body.get("name") or "").strip()[:64] or username

        with _store_lock:
            try:
                users = _load_users()
            except AccountStoreError as e:
                logger.error(f"[Account] register failed: {e}")
                return _json_response({"status": "error", "reason": "store", "message": "Account store unavailable"})
            if any(
                isinstance(u, dict) and str(u.get("username", "")).casefold() == username.casefold()
                for u in users["users"]
            ):
                return _json_response({"status": "error", "reason": "username_taken",
                                       "message": "Username already registered"})

            user_id = uuid.uuid4().hex[:12]
            agent_id = f"t_{user_id}"
            salt = _new_salt()
            user = {
                "id": user_id,
                "username": username,
                "name": name,
                "agent_id": agent_id,
                "password_hash": _hash_password(password, salt),
                "salt": salt.hex(),
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            try:
                _create_teacher_agent(agent_id, name)
            except Exception as e:
                logger.error(f"[Account] could not create the Agent for '{username}': {e}")
                return _json_response({"status": "error", "reason": "agent",
                                       "message": "Could not create the workspace"})
            users["users"].append(user)
            try:
                _save_users(users)
            except (OSError, AccountStoreError) as e:
                logger.error(f"[Account] could not persist '{username}': {e}")
                return _json_response({"status": "error", "reason": "store",
                                       "message": "Account store unavailable"})

        token = create_account_token(user)
        _set_session_cookie(token)
        logger.info(f"[Account] registered '{username}' as agent '{agent_id}'")
        return _json_response({"status": "success", "token": token, "user": _public_user(user)})


class AccountLoginHandler:
    def POST(self):
        body = _request_body()
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        if not username or not password:
            return _json_response({"status": "error", "reason": "invalid",
                                   "message": "Username and password are required"})

        client = _client_ip()
        scope = _limiter_scope(client)
        wait = _login_limiter.locked_for(scope, client)
        if wait:
            return _json_response({"status": "error", "reason": "locked", "retry_after": wait,
                                   "message": f"Too many attempts. Try again in {wait} seconds."})

        try:
            user = find_user(username=username)
        except AccountStoreError as e:
            logger.error(f"[Account] login failed: {e}")
            return _json_response({"status": "error", "reason": "store",
                                   "message": "Account store unavailable"})
        if user is None:
            _burn_password_check(password)
            _login_limiter.failed(scope, client)
            logger.warning(f"[Account] login for unknown user from {client}")
            return _json_response({"status": "error", "reason": "invalid_credentials",
                                   "message": "Wrong username or password"})
        if not _verify_password(user, password):
            _login_limiter.failed(scope, client)
            logger.warning(f"[Account] wrong password for '{username}' from {client}")
            return _json_response({"status": "error", "reason": "invalid_credentials",
                                   "message": "Wrong username or password"})

        _login_limiter.succeeded(scope, client)
        token = create_account_token(user)
        _set_session_cookie(token)
        return _json_response({"status": "success", "token": token, "user": _public_user(user)})


class AccountLogoutHandler:
    def POST(self):
        _discard_request_body()
        web.setcookie(COOKIE_NAME, "", expires=-1, path="/")
        return _json_response({"status": "success"})


class AccountMeHandler:
    """Who the caller is, so the console can render their own tenant name."""

    def GET(self):
        if not accounts_enabled():
            return _json_response({"status": "success", "user": None, "account_mode": False})
        _require_auth()
        if _account_identity() is None:
            _unauthorized()
        claims = read_account_token(_presented_token())
        try:
            user = find_user(user_id=claims["uid"]) if claims else None
        except AccountStoreError as e:
            logger.error(f"[Account] me failed: {e}")
            return _json_response({"status": "error", "reason": "store",
                                   "message": "Account store unavailable"})
        if user is None:
            _unauthorized()
        return _json_response({"status": "success", "user": _public_user(user), "account_mode": True})
