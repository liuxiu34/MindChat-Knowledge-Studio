# -*- coding: utf-8 -*-
"""MindChat Knowledge Studio M3 本地 Bridge HTTP 服务。"""
from __future__ import annotations

import argparse
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .importers import parse_bytes
from .pipeline import extract_cards, link_cards


class Handler(BaseHTTPRequestHandler):
    """处理健康检查、文件归一化和知识管线请求。"""

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # 新项目正式前端使用 8800；开发预览端口 8790 也允许访问 Bridge。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, {})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": "mindchat-knowledge-studio-bridge", "version": 1})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            path = self.path
            if path == "/api/import/normalize":
                result = parse_bytes(str(body["filename"]), base64.b64decode(body["content_base64"]))
                self._send(200, result.as_dict())
                return
            if path == "/api/knowledge/extract":
                cards = extract_cards(body.get("messages", []), body.get("provider", "dry-run"), body.get("endpoint", "http://127.0.0.1:11434"), body.get("model", "qwen2.5:3b"), body.get("api_key", ""))
                self._send(200, {"cards": cards, "provider": body.get("provider", "dry-run")})
                return
            if path == "/api/knowledge/link":
                links = link_cards(body.get("cards", []), body.get("provider", "dry-run"), body.get("endpoint", "http://127.0.0.1:11434"), body.get("model", "qwen2.5:3b"), body.get("api_key", ""))
                self._send(200, {"semanticEdges": links, "provider": body.get("provider", "dry-run")})
                return
            if path == "/api/knowledge/analyze":
                result = parse_bytes(str(body["filename"]), base64.b64decode(body["content_base64"]))
                if result.graph is not None:
                    self._send(200, {"source": "import", "graph": result.graph})
                    return
                provider = body.get("provider", "dry-run")
                cards = extract_cards(result.as_dict()["messages"], provider, body.get("endpoint", "http://127.0.0.1:11434"), body.get("model", "qwen2.5:3b"), body.get("api_key", ""))
                links = link_cards(cards, provider, body.get("endpoint", "http://127.0.0.1:11434"), body.get("model", "qwen2.5:3b"), body.get("api_key", ""))
                self._send(200, {"source": "analysis", "messages": result.as_dict()["messages"], "cards": cards, "semanticEdges": links})
                return
            self._send(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": str(exc)[:500]})


def main() -> None:
    """启动本地 Bridge。"""
    parser = argparse.ArgumentParser(description="MindChat Knowledge Studio Bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"bridge listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
