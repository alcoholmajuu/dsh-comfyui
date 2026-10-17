"""Cloudflare Access is the only way in: every request must carry a valid
Cf-Access-Jwt-Assertion for this application.

People arrive through the Access login (browser SSO or Managed OAuth) and are
matched on email. Headless clients send an Access service token
(CF-Access-Client-Id / CF-Access-Client-Secret); their JWT has no email and
carries the token's Client ID in `common_name`.
"""

from __future__ import annotations

import re
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
from fastapi import HTTPException, Request

DISCOVERY_RETRY_SECONDS = 30


class AccessVerifier:
    """Verifies Access JWTs. The application's audience tag (AUD) is either
    configured, or looked up from Cloudflare by the public hostname: an
    unauthenticated browser request to a protected hostname is redirected to
    the team's login page with the AUD in `kid`. Until an Access application
    exists for the hostname there is no AUD, and every request is refused."""

    def __init__(self, team_domain: str, aud: str, public_hostname: str = "") -> None:
        host = team_domain.removeprefix("https://").strip("/")
        if "." not in host:
            host = f"{host}.cloudflareaccess.com"
        self.issuer = f"https://{host}"
        self.aud = aud
        self.public_hostname = "" if aud else public_hostname
        self._tried_at = 0.0
        self._jwks = jwt.PyJWKClient(f"{self.issuer}/cdn-cgi/access/certs", lifespan=3600)

    def _discover(self) -> None:
        if not self.public_hostname or time.monotonic() - self._tried_at < DISCOVERY_RETRY_SECONDS:
            return
        self._tried_at = time.monotonic()
        try:
            response = httpx.get(
                f"https://{self.public_hostname}/",
                headers={"User-Agent": "Mozilla/5.0 (comfy-gateway)", "Accept": "text/html"},
                follow_redirects=False,
                timeout=10,
            )
        except httpx.HTTPError:
            return
        location = urlsplit(response.headers.get("location", ""))
        expected = f"/cdn-cgi/access/login/{self.public_hostname}"
        if f"{location.scheme}://{location.netloc}" != self.issuer or location.path != expected:
            return
        kid = (parse_qs(location.query).get("kid") or [""])[0]
        if re.fullmatch(r"[0-9a-f]{64}", kid):
            self.aud = kid

    def verify(self, token: str) -> dict[str, Any]:
        if not self.aud:
            self._discover()
        if not self.aud:
            raise HTTPException(status_code=503, detail="no Cloudflare Access application yet")
        key = self._jwks.get_signing_key_from_jwt(token)
        try:
            return self._decode(token, key)
        except jwt.InvalidAudienceError:
            if not self.public_hostname:
                raise
            previous, self.aud = self.aud, ""
            self._discover()  # the Access application may have been recreated
            self.aud = self.aud or previous
            return self._decode(token, key)

    def _decode(self, token: str, key: Any) -> dict[str, Any]:
        return jwt.decode(
            token, key.key, algorithms=["RS256"], audience=self.aud, issuer=self.issuer
        )


def require_caller(request: Request) -> str:
    """Returns who is calling (an email or a service token id), or raises."""
    state = request.app.state
    settings = state.settings
    if settings.dev_no_auth:
        return "dev"
    if state.access is None:
        raise HTTPException(status_code=503, detail="Cloudflare Access is not configured")
    assertion = request.headers.get("cf-access-jwt-assertion", "")
    if not assertion:
        raise HTTPException(status_code=401, detail="Cloudflare Access login required")
    try:
        claims = state.access.verify(assertion)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=403, detail="invalid Cloudflare Access token") from None

    email = str(claims.get("email", "")).lower()
    if email:
        if email in settings.owner_emails:
            return email
        raise HTTPException(status_code=403, detail="this account is not allowed")
    token_id = str(claims.get("common_name", "")).lower()
    allowed = settings.service_token_ids
    if token_id and (token_id in allowed or "*" in allowed):  # "*": whatever the Access policy admits
        return token_id
    raise HTTPException(status_code=403, detail="this service token is not allowed")
