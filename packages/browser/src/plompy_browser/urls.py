from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit, urlunsplit

from .config import BrowserError


def public_address(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def parse_public_url(value: str) -> tuple[str, str, int]:
    if not isinstance(value, str) or len(value) > 8192 or any(ord(char) < 33 for char in value):
        raise BrowserError("url_blocked: expected a bounded explicit public HTTP(S) URL")
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or "\\" in value):
            raise ValueError()
        hostname = parsed.hostname.rstrip(".").lower().encode("idna").decode()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if port not in {80, 443}:
            raise ValueError()
        if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal", ".home", ".lan", ".onion")):
            raise ValueError()
        try:
            if not public_address(hostname):
                raise ValueError()
        except ValueError:
            # Names containing ':' or consisting only of numeric IP syntax are not DNS fallbacks.
            if ":" in hostname or hostname.replace(".", "").isdigit():
                raise
            if "." not in hostname:
                raise
        return value, hostname, port
    except (ValueError, UnicodeError):
        raise BrowserError("url_blocked: only public HTTP(S) destinations on ports 80/443 are allowed") from None


async def checked_url(value: str, resolver=None) -> str:
    url, hostname, port = parse_public_url(value)
    resolver = resolver or asyncio.get_running_loop().getaddrinfo
    try:
        addresses = await asyncio.wait_for(resolver(hostname, port, type=socket.SOCK_STREAM), timeout=5)
    except (OSError, TimeoutError):
        raise BrowserError("dns_unavailable: destination could not be checked") from None
    if not addresses or any(not public_address(item[4][0]) for item in addresses):
        raise BrowserError("url_blocked: destination DNS includes a non-public address")
    return url


def display_url(value: str) -> str:
    """Do not echo OAuth codes, tokens, credentials or signed queries into logs."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        netloc = host + (f":{parsed.port}" if parsed.port else "")
        return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))
    except ValueError:
        return "[unreadable URL]"
