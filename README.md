# MindChat Knowledge Studio

全新的独立项目：把 qibu 的对话白板和 knowledge-canvas 的知识提取/图谱能力重新组合到一个应用中。

开发前置文档：[`开发文档.md`](./开发文档.md)

进度记录：[`项目开发进度.md`](./项目开发进度.md)

本项目不会修改原来的 qibu 或 knowledge-canvas。

## 启动

先启动 Bridge：

```powershell
start-bridge.bat
```

再启动前端静态服务：

```powershell
python -m http.server 8800 -d client
```

正式白板入口使用 qibu 基座：

```powershell
python -m http.server 8800 -d client
```

打开 <http://127.0.0.1:8800/index.html>。旧 `web/` 目录保留为原型参考，不是正式入口。

## 当前能力

- 四种文件导入：`.txt`、`.md`、`.json`、`.docx`。
- 对话顺序边与知识语义边分层保存和显示。
- Bridge 支持 `dry-run`、本地 Ollama、云端 OpenAI 兼容模型。
- 多画布、搜索、localStorage 持久化和备份恢复。

详细约束和后续扩展见 [`开发文档.md`](./开发文档.md)。
