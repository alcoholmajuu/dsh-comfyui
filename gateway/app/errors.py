"""The one error type the gateway raises; `status` becomes the HTTP status."""

from __future__ import annotations


class GatewayError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
