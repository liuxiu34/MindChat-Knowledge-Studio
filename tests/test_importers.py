# -*- coding: utf-8 -*-
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from bridge.importers import parse_file, parse_json, parse_markdown, parse_text


class ImporterTests(unittest.TestCase):
    """M1 四种输入格式的回归测试。"""

    def test_gemini_text_export(self):
        text = """From: https://example.com

you asked
message time: 2026-09-08 22:31:58
第一个问题？

gemini response
message time: 2026-09-08 22:31:58
这是第一个回答，内容足够长。

you asked
第二个问题？
gemini response
这是第二个回答，内容足够长。"""
        messages = parse_text(text, "sample.txt")
        self.assertEqual(4, len(messages))
        self.assertEqual("user", messages[0].role)
        self.assertEqual("assistant", messages[1].role)

    def test_gemini_json_contents_array(self):
        payload = [
            {"role": "user", "contents": [{"type": "text", "content": "JSON 问题？"}]},
            {"role": "assistant", "contents": [{"type": "text", "content": "JSON 回答内容。"}]},
        ]
        result = parse_json(json.dumps(payload, ensure_ascii=False), "sample.json")
        self.assertEqual(2, len(result.messages))
        self.assertEqual("JSON 问题？", result.messages[0].content)

    def test_markdown_qa(self):
        messages = parse_markdown("## Q1: 问题一\n\n问：问题一\n答：回答一\n\n## Q2: 问题二\n\n问：问题二\n答：回答二", "sample.md")
        self.assertEqual(4, len(messages))
        self.assertEqual("回答二", messages[-1].content)

    def test_docx(self):
        xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>## Q1: DOCX</w:t></w:r></w:p><w:p><w:r><w:t>问：是否支持？</w:t></w:r></w:p><w:p><w:r><w:t>答：支持。</w:t></w:r></w:p></w:body></w:document>'
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("word/document.xml", xml)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sample.docx"
            path.write_bytes(buffer.getvalue())
            result = parse_file(path)
        self.assertEqual(2, len(result.messages))
        self.assertEqual("是否支持？", result.messages[0].content)

    def test_knowledge_graph_json(self):
        result = parse_json(json.dumps({"nodes": [{"id": "qa-1", "title": "主题"}], "edges": []}), "graph.json")
        self.assertEqual([], result.messages)
        self.assertEqual(1, len(result.graph["nodes"]))


if __name__ == "__main__":
    unittest.main()
