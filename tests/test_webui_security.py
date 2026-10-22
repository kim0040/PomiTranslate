"""The legacy web UI: who may call it, what it may write, and when it remembers settings."""

from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import webui_server  # noqa: E402
from webui_server import AppServer, JobManager, build_payload_config, is_loopback_host  # noqa: E402

RESULTS: list[str] = []


def record(name: str) -> None:
    RESULTS.append(name)
    print(f"PASS {name}")


@contextmanager
def running(manager: JobManager | None = None, **options):  # noqa: ANN201
    server = AppServer(("127.0.0.1", 0), job_manager=manager or JobManager(), **options)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def call(server: AppServer, method: str, path: str, *, headers: dict | None = None, body=None, token=None, host=None):  # noqa: ANN001, ANN201
    port = server.server_address[1]
    sent = {"Host": host or f"127.0.0.1:{port}"}
    if token:
        sent["X-Pomi-Token"] = token
    sent.update(headers or {})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        payload = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode("utf-8")
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for name, value in sent.items():
            connection.putheader(name, value)
        if payload is not None:
            connection.putheader("Content-Length", str(len(payload)))
        connection.endheaders(payload)
        response = connection.getresponse()
        raw = response.read()
        return response.status, raw, dict(response.getheaders())
    finally:
        connection.close()


JSON = {"Content-Type": "application/json"}


def make_world(root: Path, name: str = "world") -> Path:
    world = root / name
    (world / "region").mkdir(parents=True)
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    return world


class Isolated:
    """Keep the tests away from the real settings, keyring and data folder."""

    def __init__(self, root: Path) -> None:
        self.saved: list[str] = []
        self.keys: list[tuple[str, str]] = []
        self.patches = [
            patch.object(webui_server, "web_data_dir", lambda: root / "webui-data"),
            patch("mwt.userdata.user_data_dir", lambda: root / "user-data"),
            patch("mwt.userdata.remember_user_settings", lambda settings, root=None: self.saved.append(settings["provider"])),
            patch("mwt.secrets.remember_api_key", lambda account, secret: self.keys.append((account, secret))),
        ]

    def __enter__(self) -> "Isolated":
        for item in self.patches:
            item.start()
        return self

    def __exit__(self, *exc) -> None:  # noqa: ANN002
        for item in reversed(self.patches):
            item.stop()


def wait_for(predicate, seconds: float = 20.0) -> None:  # noqa: ANN001
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("timed out")


def token_of(server: AppServer) -> str:
    status, raw, _ = call(server, "GET", "/")
    assert status == 200
    text = raw.decode("utf-8")
    marker = f'<meta name="{webui_server.TOKEN_META_NAME}" content="'
    return text.split(marker, 1)[1].split('"', 1)[0]


def test_requests_need_the_token_and_the_right_origin() -> None:
    with running() as server:
        token = token_of(server)
        assert token == server.session_token and len(token) >= 32
        port = server.server_address[1]
        # No token / wrong token: every API route, read or write.
        for method, path in (("GET", "/api/meta"), ("GET", "/api/jobs"), ("GET", "/api/jobs/abc"), ("POST", "/api/jobs"), ("POST", "/api/models"), ("POST", "/api/prompt-assist"), ("POST", "/api/jobs/abc/cancel")):
            for supplied in (None, "wrong-token", token[:-1]):
                status, _, _ = call(server, method, path, headers=JSON, body={} if method == "POST" else None, token=supplied)
                assert status == 403, (method, path, supplied, status)
        status, raw, _ = call(server, "GET", "/api/meta", token=token)
        assert status == 200 and "providers" in json.loads(raw)
        status, _, _ = call(server, "GET", "/api/jobs", token=token)
        assert status == 200
        # Host header: another name (DNS rebinding) or another port is refused, also for the page itself.
        for host in (f"evil.example:{port}", f"127.0.0.1:{port + 1}", "127.0.0.1", f"localhost.evil.example:{port}", f"[::2]:{port}"):
            for path in ("/", "/api/meta", "/app.js", "/healthz"):
                status, _, _ = call(server, "GET", path, token=token, host=host)
                assert status == 403, (host, path, status)
        for host in (f"127.0.0.1:{port}", f"localhost:{port}"):
            assert call(server, "GET", "/api/meta", token=token, host=host)[0] == 200
        # Origin: when a browser sends one it must be this page's own.
        for origin in ("http://evil.example", f"http://127.0.0.1:{port + 1}", "null", "https://127.0.0.1:%d" % port, f"http://localhost:{port}"):
            status, _, _ = call(server, "GET", "/api/meta", token=token, headers={"Origin": origin})
            assert status == 403, (origin, status)
            status, _, _ = call(server, "POST", "/api/models", token=token, headers={**JSON, "Origin": origin}, body={})
            assert status == 403, (origin, status)
        assert call(server, "GET", "/api/meta", token=token, headers={"Origin": f"http://127.0.0.1:{port}"})[0] == 200
        assert call(server, "GET", "/api/meta", token=token, headers={"Sec-Fetch-Site": "cross-site"})[0] == 403
        assert call(server, "GET", "/api/meta", token=token, headers={"Sec-Fetch-Site": "same-origin"})[0] == 200
        # Content type: a cross-site form or text/plain post cannot be a JSON call.
        for headers in ({"Content-Type": "text/plain"}, {"Content-Type": "application/x-www-form-urlencoded"}, {"Content-Type": "text/plain;charset=UTF-8"}, {}):
            status, _, _ = call(server, "POST", "/api/models", token=token, headers=headers, body=b"{}")
            assert status == 415, (headers, status)
        status, _, _ = call(server, "POST", "/api/models", token=token, headers={"Content-Type": "application/json; charset=utf-8"}, body={})
        assert status == 400, "a JSON call passes the checks and fails only on its own content"
        # The page carries the token; nothing else does, and each launch has its own.
        status, raw, headers = call(server, "GET", "/")
        assert token.encode() in raw and headers.get("Cache-Control") == "no-store"
        assert token.encode() not in call(server, "GET", "/app.js")[1]
        assert token.encode() not in call(server, "GET", "/api/meta", token=token)[1]
        assert call(server, "GET", "/healthz")[0] == 200
        with running() as other:
            assert token_of(other) != token
    record("webui.token_host_origin_content_type")


def test_remote_binding_is_refused_unless_allowed() -> None:
    for host in ("0.0.0.0", "::", "192.168.1.20", "example.com"):
        assert not is_loopback_host(host), host
        try:
            AppServer((host, 0))
        except ValueError as exc:
            assert "--allow-remote" in str(exc)
        else:
            raise AssertionError(f"{host} must be refused")
    for host in ("127.0.0.1", "localhost", "::1", "[::1]"):
        assert is_loopback_host(host), host
    try:
        webui_server.main(["--host", "0.0.0.0", "--port", "0"])
    except SystemExit as exc:
        assert "allow-remote" in str(exc)
    else:
        raise AssertionError("main must refuse a non-loopback host")
    # With the flag it binds, warns, and every API call still needs the token.
    import io
    from contextlib import redirect_stdout

    seen = io.StringIO()
    with patch.object(AppServer, "serve_forever", side_effect=KeyboardInterrupt), redirect_stdout(seen):
        webui_server.main(["--host", "0.0.0.0", "--port", "0", "--allow-remote"])
    assert "WARNING" in seen.getvalue() and "--allow-remote" in seen.getvalue()
    with running(allow_remote=True) as server:
        assert call(server, "GET", "/api/meta")[0] == 403
        assert call(server, "GET", "/api/meta", token=server.session_token)[0] == 200
    record("webui.remote_binding")


def test_client_output_paths_are_ignored() -> None:
    with tempfile.TemporaryDirectory() as raw, Isolated(Path(raw)):
        root = Path(raw)
        world = make_world(root)
        victims = {name: root / name for name in ("victim-report.txt", "victim-checkpoint.txt", "translate.py")}
        for victim in victims.values():
            victim.write_text('API_KEY = "stolen-key"\nprecious data', encoding="utf-8")
        before = {name: path.read_bytes() for name, path in victims.items()}
        config = build_payload_config(
            {
                "config": {
                    "world_dir": str(world),
                    "dry_run": True,
                    "report_path": str(victims["victim-report.txt"]),
                    "translate_py_path": str(victims["translate.py"]),
                    "backup_suffix": "/../../escape",
                    "inherit_translate_py": True,
                    "runtime": {"checkpoint_path": str(victims["victim-checkpoint.txt"])},
                }
            }
        )
        assert config["api"]["api_key"] != "stolen-key"
        assert config["backup_suffix"] == ".bak_translate"
        assert Path(config["report_path"]).parent == world.resolve() or Path(config["report_path"]).parent == world
        assert str(victims["victim-report.txt"]) not in (config["report_path"], config["runtime"]["checkpoint_path"])
        assert Path(config["translate_py_path"]).name == "translate.py" and Path(config["translate_py_path"]).resolve() != victims["translate.py"].resolve()

        with running() as server:
            token = server.session_token
            payload = {
                "config": {
                    "world_dir": str(world),
                    "dry_run": True,
                    "report_path": str(victims["victim-report.txt"]),
                    "translate_py_path": str(victims["translate.py"]),
                    "runtime": {"checkpoint_path": str(victims["victim-checkpoint.txt"]), "checkpoint_enabled": True},
                }
            }
            status, raw_job, _ = call(server, "POST", "/api/jobs", token=token, headers=JSON, body=payload)
            assert status == 201, raw_job
            job = json.loads(raw_job)
            data_dir = root / "webui-data"
            assert Path(job["summary"]["report_path"]).parent == data_dir / "reports"
            assert Path(job["summary"]["checkpoint_path"]).parent == data_dir / "checkpoints"

            def finished() -> bool:
                return json.loads(call(server, "GET", f"/api/jobs/{job['id']}", token=token)[1])["status"] in webui_server.FINISHED_STATUSES

            wait_for(finished)
            done = json.loads(call(server, "GET", f"/api/jobs/{job['id']}", token=token)[1])
            assert done["status"] == "completed", done.get("error") or done["status"]
            assert Path(job["summary"]["report_path"]).exists(), "the report goes where the server chose"
            assert not (world / "translation_report.json").exists()
        for name, path in victims.items():
            assert path.read_bytes() == before[name], f"{name} was touched"
    record("webui.output_paths_are_server_owned")


def test_settings_are_remembered_only_for_accepted_jobs() -> None:
    gate = threading.Event()
    started = threading.Event()

    def slow_run(self) -> dict:  # noqa: ANN001
        started.set()
        gate.wait(30)
        return {"status": "completed", "changed_file_count": 0, "candidate_file_count": 0, "candidate_text_count": 0}

    with tempfile.TemporaryDirectory() as raw, Isolated(Path(raw)) as isolated, patch.object(webui_server.WorldTranslator, "run", slow_run):
        root = Path(raw)
        world = make_world(root)
        manager = JobManager()

        def request(world_dir: Path, **api) -> dict:
            return {"config": {"world_dir": str(world_dir), "dry_run": False, "api": {"provider": "openai", "model": "m", "api_key": "k-1", **api}}}

        # Refused for what is wrong with the request itself: nothing is saved.
        for bad in (
            {"config": {"world_dir": str(root / "missing"), "dry_run": True}},
            {"config": {"world_dir": str(world), "dry_run": False, "api": {"provider": "openai", "model": "m"}}},
            {"config": {"world_dir": str(world), "dry_run": False, "api": {"provider": "openai", "api_key": "k"}}},
        ):
            try:
                with patch.dict("os.environ", {"OPENAI_API_KEY": ""}), patch("mwt.secrets.load_api_key", return_value=None):
                    manager.create_job(bad)
            except ValueError:
                pass
            else:
                raise AssertionError("expected the request to be refused")
        assert isolated.saved == [] and isolated.keys == []
        first = manager.create_job(request(world))
        assert isolated.saved == ["openai"] and isolated.keys == [("openai", "k-1")]
        assert started.wait(20)
        # Same world while the first job runs: refused, and its model and key are NOT stored.
        try:
            manager.create_job(request(world, model="other-model", api_key="k-2", provider="gemini"))
        except ValueError as exc:
            assert "already running" in str(exc)
        else:
            raise AssertionError("a second job for the same world must be refused")
        assert isolated.saved == ["openai"] and isolated.keys == [("openai", "k-1")], (isolated.saved, isolated.keys)
        gate.set()
        wait_for(lambda: manager.public_job(first["id"])["status"] == "completed")
    record("webui.settings_saved_after_acceptance")


def test_history_is_bounded_and_keys_are_dropped() -> None:
    def quick_run(self) -> dict:  # noqa: ANN001
        return {"status": "completed", "changed_file_count": 0, "candidate_file_count": 0, "candidate_text_count": 0, "big": "x" * 1000}

    with tempfile.TemporaryDirectory() as raw, Isolated(Path(raw)), patch.object(webui_server.WorldTranslator, "run", quick_run), patch.object(webui_server, "MAX_JOB_HISTORY", 3):
        root = Path(raw)
        manager = JobManager()
        ids = []
        for index in range(7):
            world = make_world(root, f"world-{index}")
            job = manager.create_job({"config": {"world_dir": str(world), "dry_run": False, "api": {"provider": "openai", "model": "m", "api_key": f"secret-{index}"}}})
            ids.append(job["id"])
            wait_for(lambda job=job: manager.jobs.get(job["id"]) is None or manager.jobs[job["id"]]["status"] == "completed")
            wait_for(lambda job=job: manager.jobs.get(job["id"]) is None or manager.jobs[job["id"]]["_config"] is None)
        assert len(manager.jobs) <= 3 + 0, len(manager.jobs)
        assert all(job["_config"] is None for job in manager.jobs.values()), "the API key outlived its job"
        assert not any("secret-" in json.dumps(job, default=str) for job in manager.jobs.values())
        assert manager.active_world_dirs == set()
        listing = manager.list_jobs()
        assert all(item["events"] == [] and "big" not in (item["result"] or {}) for item in listing)
        assert ids[0] not in manager.jobs and ids[-1] in manager.jobs
    record("webui.history_bounded_and_config_dropped")


def run_all() -> list[str]:
    RESULTS.clear()
    test_requests_need_the_token_and_the_right_origin()
    test_remote_binding_is_refused_unless_allowed()
    test_client_output_paths_are_ignored()
    test_settings_are_remembered_only_for_accepted_jobs()
    test_history_is_bounded_and_keys_are_dropped()
    return list(RESULTS)


if __name__ == "__main__":
    run_all()
    print("WEBUI_SECURITY_PASSED")
