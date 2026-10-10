"""The optional legacy web UI only answers its own page: token, Host/Origin, JSON and safe paths.

Uses a real server on an ephemeral loopback port. No keychain, provider or user data is touched:
the keyring and the user data folder are replaced for the duration of the test.
"""

from __future__ import annotations

import http.client
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import webui_server  # noqa: E402


class Capture(BaseHTTPRequestHandler):
    """A stand-in provider that records the Authorization header it receives."""

    seen: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        Capture.seen.append(self.headers.get("Authorization") or "")
        raw = b'{"data":[{"id":"fixture-model"}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def _serve(server: ThreadingHTTPServer) -> None:
    threading.Thread(target=server.serve_forever, daemon=True).start()


def _request(port: int, method: str, path: str, *, body: object | None = None, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    raw = None if body is None else json.dumps(body).encode("utf-8")
    sent = {"Host": f"127.0.0.1:{port}"}
    if raw is not None:
        sent["Content-Type"] = "application/json"
    sent.update(headers or {})
    connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    for name, value in sent.items():
        connection.putheader(name, value)
    if raw is not None:
        connection.putheader("Content-Length", str(len(raw)))
    connection.endheaders(raw)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response.status, data


def main() -> None:
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        data_dir = tmp / "userdata"
        data_dir.mkdir()
        world = tmp / "world"
        world.mkdir()
        (world / "level.dat").write_bytes(b"synthetic")
        provider = ThreadingHTTPServer(("127.0.0.1", 0), Capture)
        _serve(provider)
        provider_url = f"http://127.0.0.1:{provider.server_address[1]}/v1"
        server = webui_server.WebUIServer(("127.0.0.1", 0))
        _serve(server)
        port = server.server_address[1]
        token = server.webui_token
        auth = {webui_server.TOKEN_HEADER: token}
        leaked_env = {"OPENAI_API_KEY": "leak-env-openai", "COMET_API_KEY": "leak-env-comet", "CUSTOM_API_KEY": "", "CUSTOM_BASE_URL": ""}
        try:
            with patch("mwt.userdata.user_data_dir", return_value=data_dir), \
                    patch("mwt.secrets.load_api_key", return_value="leak-keyring"), \
                    patch("mwt.secrets.remember_api_key", side_effect=AssertionError("tests must not write the keychain")), \
                    patch.dict(os.environ, leaked_env):
                # The page carries this launch's token and is not cacheable or frameable.
                status, page = _request(port, "GET", "/")
                assert status == 200
                assert token.encode() in page and b"__POMI_WEBUI_TOKEN__" not in page
                assert len(token) >= 32

                # API calls need the token, on every method.
                assert _request(port, "GET", "/api/meta")[0] == 403
                assert _request(port, "GET", "/api/meta", headers={webui_server.TOKEN_HEADER: "wrong"})[0] == 403
                assert _request(port, "GET", "/api/meta", headers=auth)[0] == 200
                assert _request(port, "GET", "/api/jobs", headers=auth)[0] == 200
                assert _request(port, "POST", "/api/jobs", body={})[0] == 403

                # DNS rebinding: a foreign Host name is refused even with the page and token.
                for host in ("evil.example.test", f"evil.example.test:{port}", "127.0.0.1:1"):
                    assert _request(port, "GET", "/", headers={"Host": host})[0] == 403, host
                    assert _request(port, "GET", "/api/meta", headers={"Host": host, **auth})[0] == 403, host
                assert _request(port, "GET", "/", headers={"Host": f"localhost:{port}"})[0] == 200

                # Another site's page cannot post, even with a stolen token.
                for headers in ({"Origin": "http://evil.example.test"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}):
                    assert _request(port, "POST", "/api/models", body={}, headers={**auth, **headers})[0] == 403, headers
                assert _request(port, "POST", "/api/jobs/x/cancel", body={}, headers={**auth, "Origin": f"http://127.0.0.1:{port}"})[0] == 404

                # Only JSON bodies (a cross-site "simple" form or text/plain post is refused).
                for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""):
                    status, _ = _request(port, "POST", "/api/models", body={}, headers={**auth, "Content-Type": content_type})
                    assert status == 415, content_type

                # An empty key with a request-chosen endpoint never borrows env/keyring/translate.py keys.
                Capture.seen.clear()
                models = {"config": {"api": {"provider": "custom", "base_url": provider_url, "api_key": "", "model": ""}}}
                _request(port, "POST", "/api/models", body=models, headers=auth)
                assert not any("leak" in header for header in Capture.seen), Capture.seen
                for provider_id in ("custom", "openai", "comet"):
                    config = webui_server.build_payload_config({"api": {"provider": provider_id, "base_url": provider_url, "api_key": ""}})
                    assert config["api"]["api_key"] == "", provider_id
                # The provider's own default endpoint keeps the documented environment fallback.
                config = webui_server.build_payload_config({"api": {"provider": "openai", "api_key": ""}})
                assert config["api"]["api_key"] == "leak-env-openai"
                # A key typed in the page is always used as given.
                typed = webui_server.build_payload_config({"api": {"provider": "custom", "base_url": provider_url, "api_key": "typed"}})
                assert typed["api"]["api_key"] == "typed"

                # Reports and checkpoints stay in the world folder or the data folder.
                outside = tmp / "outside" / "victim.txt"
                for field in ({"report_path": str(outside)}, {"runtime": {"checkpoint_path": str(outside)}}):
                    job = {"config": {"world_dir": str(world), "dry_run": True, **field}}
                    status, raw = _request(port, "POST", "/api/jobs", body=job, headers=auth)
                    assert status == 400, raw
                    assert b"must be inside" in raw
                    assert not outside.exists()
                for good in (str(world / "my-report.json"), "relative-report.json", str(data_dir / "report.json")):
                    config = webui_server.build_payload_config({"world_dir": str(world), "report_path": good})
                    assert Path(config["report_path"]).resolve().is_relative_to(world.resolve()) or \
                        Path(config["report_path"]).resolve().is_relative_to(data_dir.resolve())
                try:
                    webui_server.build_payload_config({"world_dir": str(world), "report_path": str(world / ".." / "escape.json")})
                except ValueError:
                    pass
                else:
                    raise AssertionError("a path that leaves the world folder must be refused")
        finally:
            server.shutdown()
            server.server_close()
            provider.shutdown()
            provider.server_close()
    assert webui_server.allowed_host_headers("0.0.0.0", 8765) == {"127.0.0.1:8765", "localhost:8765", "[::1]:8765"}
    assert "[::1]:9" in webui_server.allowed_host_headers("::1", 9)
    print("WEBUI_SECURITY_PASSED")


if __name__ == "__main__":
    main()
