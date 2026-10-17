# dsh-comfyui Gateway

An MCP/REST server connecting to ComfyUI. Run it on the GPU machine with Python 3.12 or later.
ComfyUI itself and model files are not included.

```sh
uv sync --project gateway
# Copy gateway/.env.example outside the repository and edit its settings
export DSH_COMFYUI_GATEWAY_ENV_FILE=/absolute/path/to/gateway.env
npm run gateway:check
npm run gateway
```

In Windows PowerShell, use `$env:DSH_COMFYUI_GATEWAY_ENV_FILE='D:\config\gateway.env'`.
The launcher uses Python from `gateway/.venv`, or the executable specified by `DSH_COMFYUI_PYTHON`.
The default ComfyUI endpoint is `http://127.0.0.1:8188`; the Gateway listens on `127.0.0.1:8790`.
Environment variables override configuration-file values. Without an explicit path, the launcher reads `gateway/.env` (ignored by Git).
If an explicitly selected configuration file does not exist, startup stops.

The Gateway normally validates Cloudflare Access JWTs. Cloudflare and DSH's mcp-remote handle Managed OAuth authorization and refresh.
Configure your own team, application AUD or public hostname, and allowed email addresses.
MCP/REST access is rejected when authentication is not configured. Use `GW_DEV_NO_AUTH=1` only for loopback development.
Manage Tunnel installation, Access configuration, and persistent services in your own environment.
Environment-specific Windows operations scripts are not included in the public package.

- MCP: `POST /mcp`
- REST: `/api/*`
- Health check: `GET /healthz`
- Workflow storage: `GW_WORKFLOW_DIR`; a directory outside the public source tree is recommended.
- Overwriting: requires `overwrite:true`. A normal save rejects name collisions with HTTP 409.

Built-in generate/edit/inpaint operations depend on the configured Qwen models and required custom nodes.
For other models, use `run_workflow` with node-definition validation. Models are not installed automatically.
