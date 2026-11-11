"""Compatibility import path for private pre-0.12 MCP configurations.

New installations use plompy_browser. This alias launches nothing and preserves
python -m szpont_browser and its provisioning/login submodules during upgrades.
"""
from plompy_browser import __path__, __version__
