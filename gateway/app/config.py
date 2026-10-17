"""Settings, read from the environment (see .env.example)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path


def _csv(value: str) -> frozenset[str]:
    return frozenset(x.strip().lower() for x in value.split(",") if x.strip())


class Settings:
    def __init__(self, src: Mapping[str, str] | None = None) -> None:
        src = os.environ if src is None else src
        self.cf_access_team_domain = src.get("CF_ACCESS_TEAM_DOMAIN", "").strip()
        self.cf_access_aud = src.get("CF_ACCESS_AUD", "").strip()
        # With no AUD configured, it is looked up from Cloudflare by this hostname.
        self.public_hostname = src.get("GW_PUBLIC_HOSTNAME", "").strip().lower()
        self.owner_emails = _csv(src.get("GW_OWNER_EMAILS", ""))
        self.service_token_ids = _csv(src.get("GW_SERVICE_TOKEN_IDS", ""))
        self.comfy_url = src.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
        self.idle_free_minutes = float(src.get("GW_IDLE_FREE_MINUTES", "15"))
        # Local testing only: skips Cloudflare Access entirely.
        self.dev_no_auth = src.get("GW_DEV_NO_AUTH", "") == "1"
        self.unet = src.get("COMFY_UNET", "qwen-image-2.1-UC-BF16.gguf")
        self.text_encoder = src.get("COMFY_TEXT_ENCODER", "qwen3vl_8b_bf16.safetensors")
        self.vae = src.get("COMFY_VAE", "qwen_image_2.1_vae_bf16.safetensors")
        # "default": encode on the GPU; ComfyUI moves the encoder to RAM when the
        # diffusion model needs the VRAM. "cpu" keeps it off the GPU (much slower edits).
        self.encoder_device = src.get("COMFY_ENCODER_DEVICE", "default")
        default_dir = Path(__file__).resolve().parent.parent / "workflows"
        self.workflow_dir = Path(src.get("GW_WORKFLOW_DIR", "") or default_dir)
