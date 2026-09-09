# -*- coding: utf-8 -*-
"""四种文件格式的统一导入适配层。

本模块只负责把外部文件转换为统一的 Message[] 或结构化知识图谱，
不负责调用模型、不负责渲染，也不修改输入文件。
"""
from __future__ import annotations

import json
import io
import re
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


@dataclass(slots=True)
class Message:
    """统一的对话消息。"""

    id: str
    role: str
    content: str
    timestamp: str = ""
    source: str = ""


@dataclass(slots=True)
class ImportResult:
    """文件导入结果；普通聊天填 messages，知识图谱 JSON 填 graph。"""

    source: str
    messages: list[Message]
    graph: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        """转换为可直接返回 API 的字典。"""
        return {
            "source": self.source,
            "messages": [asdict(message) for message in self.messages],
            "graph": self.graph,
        }


USER_LABEL = re.compile(
    r"^(?:#{1,6}\s*)?(user|me|human|visitor|client|person\s*\d*|you\s+asked|用户|我|访客|提问者)(?=$|\s|[:：])\s*(?::|：)?\s*(.*)$",
    re.IGNORECASE,
)
ASSISTANT_LABEL = re.compile(
    r"^(?:#{1,6}\s*)?(assistant|ai|chatgpt|claude|gemini|gpt|model|deepseek|bot|助手|机器人|客服)(?=$|\s|[:：])\s*(?:response\s*)?(?::|：)?\s*(.*)$",
    re.IGNORECASE,
)
TIMESTAMP = re.compile(
    r"^(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?)$"
)
NOISE = re.compile(r"^(?:from:\s*https?://|powered by .*exporter)", re.IGNORECASE)
QA_HEADING = re.compile(
    r"^(?:#{1,6}\s*(?:q|问|问题)\s*\d*\s*[:：.]?|\*\*\s*(?:q|问)\s*\d*\s*[:：.]?\*\*|【\s*问\s*\d*\s*】|#{2}\s*\d+[.\s])",
    re.IGNORECASE,
)


def _clean(value: Any) -> str:
    """把任意输入值安全转成去首尾空白的字符串。"""
    return str(value or "").replace("\ufeff", "").strip()


def _message_content(item: dict[str, Any]) -> str:
    """兼容 content/text/say/body 与 Gemini contents 文本数组。"""
    value = item.get("content") or item.get("text") or item.get("say") or item.get("message") or item.get("body")
    if isinstance(value, list):
        value = "\n".join(_clean(part.get("text") if isinstance(part, dict) else part) for part in value)
    if not value and isinstance(item.get("contents"), list):
        value = "\n".join(
            _clean(part.get("content") or part.get("text"))
            for part in item["contents"]
            if isinstance(part, dict) and part.get("type", "text") == "text"
        )
    return _clean(value)


def _role(value: Any) -> str | None:
    """将外部角色名归一化为 user/assistant。"""
    text = _clean(value).lower()
    if re.search(r"assistant|model|bot|ai|gpt|claude|gemini|deepseek", text):
        return "assistant"
    if re.search(r"user|human|me|visitor|client|person|用户|我|访客|提问", text):
        return "user"
    return None


def _messages_from_items(items: list[Any], source: str) -> list[Message]:
    """把消息对象数组转换为 Message[]，过滤思考块和空消息。"""
    messages: list[Message] = []
    for index, item in enumerate(items, 1):
        if not isinstance(item, dict):
            continue
        role = _role(item.get("role") or item.get("sender") or item.get("author") or item.get("type"))
        content = _message_content(item)
        if not role or not content:
            continue
        messages.append(Message(
            id=_clean(item.get("id")) or f"msg-{index:04d}",
            role=role,
            content=content,
            timestamp=_clean(item.get("timestamp") or item.get("time") or item.get("created_at")),
            source=source,
        ))
    return messages


def parse_text(text: str, source: str = "input.txt") -> list[Message]:
    """解析带说话人标签的 txt/聊天导出文本。"""
    messages: list[Message] = []
    current_role: str | None = None
    current_content: list[str] = []
    current_timestamp = ""

    def flush() -> None:
        nonlocal current_role, current_content, current_timestamp
        content = "\n".join(current_content).strip()
        if current_role and content:
            messages.append(Message(
                id=f"msg-{len(messages) + 1:04d}", role=current_role,
                content=content, timestamp=current_timestamp, source=source,
            ))
        current_role, current_content, current_timestamp = None, [], ""

    for raw_line in _clean(text).splitlines():
        line = raw_line.strip()
        if not line or NOISE.match(line) or line.lower() == "thinking":
            continue
        user_match = USER_LABEL.match(line)
        assistant_match = ASSISTANT_LABEL.match(line)
        if user_match:
            flush()
            current_role = "user"
            if user_match.group(2).strip():
                current_content.append(user_match.group(2).strip())
            continue
        if assistant_match:
            flush()
            current_role = "assistant"
            if assistant_match.group(2).strip():
                current_content.append(assistant_match.group(2).strip())
            continue
        if current_role is None:
            continue
        if not current_timestamp and TIMESTAMP.match(line):
            current_timestamp = line
            continue
        if not line.startswith("<FollowUp"):
            current_content.append(raw_line.rstrip())
    flush()
    return messages


def _markdown_chunks(text: str) -> list[tuple[str, str]]:
    """按 Q&A 标题或二级标题切分 Markdown。"""
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if QA_HEADING.match(line.strip())]
    if len(starts) < 2:
        starts = [i for i, line in enumerate(lines) if re.match(r"^#{2,3}\s+\S", line.strip())]
    if not starts:
        return [("(无标题)", text.strip())]
    chunks: list[tuple[str, str]] = []
    bounds = starts + [len(lines)]
    for start, end in zip(bounds, bounds[1:]):
        block = lines[start:end]
        heading = re.sub(r"^#{1,6}\s*", "", block[0]).replace("**", "").strip()
        body = "\n".join(block[1:]).strip()
        if body:
            chunks.append((heading or "(无标题)", body))
    return chunks


def parse_markdown(text: str, source: str = "input.md") -> list[Message]:
    """解析普通 Q&A Markdown；若识别到聊天导出标记则复用文本解析。"""
    if re.search(r"^\s*#{0,6}\s*(?:you\s+asked|(?:gemini|chatgpt|claude|gpt|deepseek)\s+response)\s*$", text, re.IGNORECASE | re.MULTILINE):
        return parse_text(text, source)
    messages: list[Message] = []
    for index, (heading, body) in enumerate(_markdown_chunks(text), 1):
        question_match = re.search(r"^(?:问|问题|Q)\s*[:：]\s*(.+)$", body, re.IGNORECASE | re.MULTILINE)
        answer_match = re.search(r"^(?:答|回答|A)\s*[:：]\s*([\s\S]+)$", body, re.IGNORECASE | re.MULTILINE)
        question = _clean(question_match.group(1) if question_match else heading)
        answer = _clean(answer_match.group(1) if answer_match else body)
        if question:
            messages.append(Message(f"msg-{len(messages) + 1:04d}", "user", question, source=source))
        if answer:
            messages.append(Message(f"msg-{len(messages) + 1:04d}", "assistant", answer, source=source))
    return messages


def parse_json(text: str, source: str = "input.json") -> ImportResult:
    """解析消息 JSON、Gemini 数组 JSON 或 knowledge-canvas cards/graph JSON。"""
    data = json.loads(text)
    if isinstance(data, dict) and isinstance(data.get("messages"), list):
        return ImportResult(source, _messages_from_items(data["messages"], source))
    if isinstance(data, list) and any(isinstance(item, dict) and (item.get("role") or item.get("contents")) for item in data):
        return ImportResult(source, _messages_from_items(data, source))
    if isinstance(data, dict) and (isinstance(data.get("cards"), list) or isinstance(data.get("nodes"), list)):
        nodes = data.get("nodes") if isinstance(data.get("nodes"), list) else data.get("cards", [])
        graph = {"version": data.get("version", 1), "nodes": nodes, "edges": data.get("edges", data.get("links", []))}
        return ImportResult(source, [], graph)
    if isinstance(data, list) and data and all(isinstance(item, dict) and (item.get("title") or item.get("summary_q")) for item in data):
        return ImportResult(source, [], {"version": 1, "nodes": data, "edges": []})
    raise ValueError("无法识别的 JSON 格式")


def extract_docx_text(raw: bytes) -> str:
    """读取 docx 正文段落，不执行宏或外部资源。"""
    source = raw if hasattr(raw, "read") else io.BytesIO(raw) if isinstance(raw, (bytes, bytearray)) else Path(raw)
    with zipfile.ZipFile(source) as archive:
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for paragraph in root.findall(".//w:p", ns):
        value = "".join(node.text or "" for node in paragraph.findall(".//w:t", ns)).strip()
        if value:
            paragraphs.append(value)
    return "\n\n".join(paragraphs)


def parse_file(path: str | Path) -> ImportResult:
    """根据扩展名解析 txt/md/json/docx 文件。"""
    file_path = Path(path)
    suffix = file_path.suffix.lower()
    raw = file_path.read_bytes()
    if suffix == ".docx":
        return ImportResult(file_path.name, parse_markdown(extract_docx_text(raw), file_path.name))
    text = raw.decode("utf-8-sig", errors="replace")
    if suffix == ".json":
        return parse_json(text, file_path.name)
    if suffix in {".md", ".markdown"}:
        return ImportResult(file_path.name, parse_markdown(text, file_path.name))
    if suffix in {".txt", ".log"}:
        return ImportResult(file_path.name, parse_text(text, file_path.name))
    raise ValueError(f"不支持的文件类型：{suffix or '(无扩展名)'}")


def parse_bytes(filename: str, raw: bytes) -> ImportResult:
    """解析 HTTP 上传的文件字节，行为与 parse_file 一致。"""
    suffix = Path(filename).suffix.lower()
    source = Path(filename).name
    if suffix == ".docx":
        return ImportResult(source, parse_markdown(extract_docx_text(raw), source))
    text = raw.decode("utf-8-sig", errors="replace")
    if suffix == ".json":
        return parse_json(text, source)
    if suffix in {".md", ".markdown"}:
        return ImportResult(source, parse_markdown(text, source))
    if suffix in {".txt", ".log"}:
        return ImportResult(source, parse_text(text, source))
    raise ValueError(f"不支持的文件类型：{suffix or '(无扩展名)'}")
