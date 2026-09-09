# 本地 Bridge

```powershell
python -m bridge.server --port 8791
```

M3 接口：

- `GET /health`
- `POST /api/import/normalize`
- `POST /api/knowledge/extract`
- `POST /api/knowledge/link`
- `POST /api/knowledge/analyze`

当前支持 `provider=dry-run`、`provider=local`（Ollama）和 `provider=cloud`（OpenAI 兼容接口）。云端 Key 只在当前 HTTP 请求头中使用。
