# 環境設定と機密情報の分離

## DSH側

`npm run connection -- --url https://gateway.example.com/mcp` で接続先を登録します。
設定は `~/.dsh/dsh-comfyui/connection.json` に600、親ディレクトリは700で保存します。
OAuthキャッシュは `~/.dsh/comfyui-oauth/` に保存します。これらはソース、Git、配布物へ含めません。
設定JSONのひな形は [connection.example.json](../config/connection.example.json) です。

|環境変数|用途|
|---|---|
|`DSH_COMFYUI_MCP_URL`|MCPエンドポイント。HTTPSまたはloopback HTTP|
|`DSH_COMFYUI_AUTH_DIR`|OAuthキャッシュの絶対パス|
|`DSH_COMFYUI_NODE`|ブリッジに使用するNode互換実行ファイル|

Studioの状態・画像は `~/.dsh/comfyui-studio/`、下書きはDSHのブラウザー領域に保存されます。
状態・生成画像・workflowにはプロンプトやファイル名が含まれるため、公開対象へコピーしないでください。

## Gateway側

[.env.example](../gateway/.env.example) をリポジトリ外へコピーし、ファイルの読み取り権限を利用者だけに制限します。
`DSH_COMFYUI_GATEWAY_ENV_FILE` で絶対パスを指定してください。環境変数が設定ファイルより優先します。
この読み込みは `npm run gateway` のlauncherが行います。uvicornを直接起動する場合はサービス側で環境を渡してください。

|設定|用途|
|---|---|
|`COMFY_URL`|ComfyUI。既定はloopbackの8188|
|`GW_PORT`|Gateway。loopbackの8790が既定|
|`GW_WORKFLOW_DIR`|保存workflow。リポジトリ外の永続データ領域を推奨|
|`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`GW_PUBLIC_HOSTNAME`|自身のAccessアプリの認証設定|
|`GW_OWNER_EMAILS`|許可する利用者。カンマ区切り|
|`GW_SERVICE_TOKEN_IDS`|任意のService Token許可設定。OAuthだけなら不要|
|`COMFY_UNET`、`COMFY_TEXT_ENCODER`、`COMFY_VAE`|組み込みQwen workflowのインストール済みモデル名|
|`COMFY_ENCODER_DEVICE`|`default`はGPU、`cpu`はCPU|
|`GW_IDLE_FREE_MINUTES`|アイドル時のモデル解放までの分数|
|`DSH_COMFYUI_PYTHON`|Gatewayを起動するPython実行ファイル|

認証情報・Tunnel credential・Service Token・OAuthキャッシュはリポジトリへ入れません。
個人の常駐スクリプト、ホスト一覧、SSH設定、デプロイ記録も利用環境側で管理してください。
ローカル開発で認証を省略する `GW_DEV_NO_AUTH=1` は、公開用の設定例には保存していません。

## 公開チェック

`npm run release:check` は公開対象のファイルを限定し、一般的な秘密鍵・トークン・個人パスを検査します。
任意の `DSH_COMFYUI_RELEASE_DENY_FILE` に、追加で除外したい文字列のJSON配列を指定できます。
そのファイル自体はリポジトリ外に置いてください。検出時にはファイル名とルール名だけを表示します。
このチェックは全種類の秘密情報の不在を保証するものではありません。
