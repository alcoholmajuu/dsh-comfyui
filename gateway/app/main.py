"""comfy-gateway: MCP (/mcp) and REST (/api) in front of a local ComfyUI."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from app.api import router as api_router
from app.auth import AccessVerifier
from app.comfy import Comfy, GatewayError
from app.config import Settings
from app.mcp import router as mcp_router


async def _idle_loop(comfy: Comfy) -> None:
    while True:
        await asyncio.sleep(60)
        with suppress(Exception):
            await run_in_threadpool(comfy.idle_tick)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_idle_loop(app.state.comfy))
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        app.state.comfy.http.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="comfy-gateway", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.comfy = Comfy(settings)
    has_app = settings.cf_access_aud or settings.public_hostname
    app.state.access = (
        AccessVerifier(
            settings.cf_access_team_domain, settings.cf_access_aud, settings.public_hostname
        )
        if settings.cf_access_team_domain and has_app
        else None
    )

    @app.exception_handler(GatewayError)
    async def gateway_error(request: Request, exc: GatewayError):
        return JSONResponse(status_code=exc.status, content={"detail": exc.message})

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    app.include_router(mcp_router)
    app.include_router(api_router)
    return app


app = create_app()
