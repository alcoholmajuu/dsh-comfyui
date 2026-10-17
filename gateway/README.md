# dsh-comfyui Gateway

ComfyUIに接続するMCP／RESTサーバーです。GPUマシン側でPython 3.12以上を使って起動します。
ComfyUI本体とモデルは含みません。

```sh
uv sync --project gateway
# gateway/.env.exampleをリポジトリ外にコピーし、設定を編集
export DSH_COMFYUI_GATEWAY_ENV_FILE=/absolute/path/to/gateway.env
npm run gateway:check
npm run gateway
```

Windows PowerShellでは `$env:DSH_COMFYUI_GATEWAY_ENV_FILE='D:\config\gateway.env'` と指定できます。
Pythonは `gateway/.venv`、または `DSH_COMFYUI_PYTHON` で指定した実行ファイルを使います。
既定の接続先はComfyUI標準の `http://127.0.0.1:8188`、Gatewayは127.0.0.1:8790に待ち受けます。
設定ファイルより実行環境の変数を優先します。指定がなければ `gateway/.env` を読みます（Git管理対象外）。
外部ファイルを明示した場合、ファイルが存在しなければ起動を中止します。

通常はCloudflare Access JWTを検証します。Managed OAuthの認可・更新はCloudflareと
DSH側のmcp-remoteが担当します。チーム、アプリのAUDまたは公開ホスト名、許可メールを自身の環境に設定してください。
認証未設定のMCP／RESTアクセスは拒否します。loopback開発時のみ `GW_DEV_NO_AUTH=1` を指定できます。
Tunnelの導入、Accessの設定、常駐サービスの登録は利用環境で管理してください。
既存の個人環境向けWindows運用スクリプトは公開パッケージに含みません。

- MCP: `POST /mcp`
- REST: `/api/*`
- ヘルスチェック: `GET /healthz`
- ワークフロー保存先: `GW_WORKFLOW_DIR`。公開ソースの外に指定することを推奨します。
- 同名保存: `overwrite:true` が必要。通常の新規保存は競合時に409で拒否します。

組み込みgenerate/edit/inpaintは設定されたQwenモデルと必要なcustom nodeに依存します。
その他のモデルはrun_workflowとノード定義の検証を使用してください。モデルは自動導入しません。
