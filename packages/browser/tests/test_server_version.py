"""Verify the actual MCP initialization response, without starting a browser."""
from importlib.metadata import version
from pathlib import Path
import tomllib

from mcp import Client

from szpont_browser import server


async def test_protocol_version_matches_installed_release(monkeypatch):
    class NoBrowserSession:
        def __init__(self, _config):
            pass

        async def close(self):
            pass

    monkeypatch.setattr(server.Config, "from_env", lambda: object())
    monkeypatch.setattr(server, "BrowserSession", NoBrowserSession)
    project = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
    expected = project["project"]["version"]
    assert version("szpont-browser") == expected, "Install this source before testing its release metadata"
    async with Client(server.mcp) as client:
        assert client.server_info.name == "Szpont Browser"
        assert client.server_info.version == expected
        assert any(tool.name == "browser_snapshot" for tool in (await client.list_tools()).tools)
