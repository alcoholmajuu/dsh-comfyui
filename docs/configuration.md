# Configuration and separation of secrets

## DSH

Register an endpoint with `npm run connection -- --url https://gateway.example.com/mcp`.
The configuration is stored in `~/.dsh/dsh-comfyui/connection.json` with mode `600`; its parent directory uses mode `700`.
OAuth caches are stored in `~/.dsh/comfyui-oauth/`. Do not include either in source control or distributions.
See [connection.example.json](../config/connection.example.json) for a configuration template.

| Environment variable | Purpose |
| --- | --- |
| `DSH_COMFYUI_MCP_URL` | MCP endpoint: HTTPS or loopback HTTP |
| `DSH_COMFYUI_AUTH_DIR` | Absolute path to the OAuth cache |
| `DSH_COMFYUI_NODE` | Node-compatible executable for the bridge |

Studio state and images are stored in `~/.dsh/comfyui-studio/`; drafts are stored in DSH's browser storage.
State, generated images, and workflows can contain prompts and filenames. Keep them out of public distributions.

## Gateway

Copy [.env.example](../gateway/.env.example) outside the repository and restrict read access to the owner.
Set `DSH_COMFYUI_GATEWAY_ENV_FILE` to its absolute path. Environment variables take precedence over file settings.
The `npm run gateway` launcher loads this file. When starting uvicorn directly, supply the environment through your service configuration.

| Setting | Purpose |
| --- | --- |
| `COMFY_URL` | ComfyUI endpoint; defaults to loopback port 8188 |
| `GW_PORT` | Gateway port; defaults to 8790 on loopback |
| `GW_WORKFLOW_DIR` | Saved workflows; use persistent storage outside the repository |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `GW_PUBLIC_HOSTNAME` | Authentication settings for your own Access application |
| `GW_OWNER_EMAILS` | Comma-separated list of allowed users |
| `GW_SERVICE_TOKEN_IDS` | Optional Service Token allowlist; unnecessary for OAuth-only use |
| `COMFY_UNET`, `COMFY_TEXT_ENCODER`, `COMFY_VAE` | Installed model names for the built-in Qwen workflows |
| `COMFY_ENCODER_DEVICE` | `default` for GPU, `cpu` for CPU |
| `GW_IDLE_FREE_MINUTES` | Idle time in minutes before unloading models |
| `DSH_COMFYUI_PYTHON` | Python executable used to start the Gateway |

Keep credentials, Tunnel credentials, Service Tokens, and OAuth caches out of the repository.
Manage service scripts, host inventories, SSH configuration, and deployment records in your own environment.
The local-development authentication bypass, `GW_DEV_NO_AUTH=1`, is deliberately absent from the distribution's configuration example.

## Release checks

`npm run release:check` restricts the public file set and checks for common private keys, tokens, and personal paths.
Optionally set `DSH_COMFYUI_RELEASE_DENY_FILE` to a JSON array of additional strings to reject.
Keep that file outside the repository. Findings report only the filename and rule name.
This check cannot guarantee the absence of every kind of secret.
