# -*- coding: utf-8 -*-
"""知识卡片抽取与关联管线。

M3 先提供可复现的 dry-run 和本地 Ollama 通道；云端通道在 M4 接入。
"""
from __future__ import annotations

import json
import re
import urllib.request
from typing import Any


RELATIONS = {"延伸", "相似", "对比", "依赖", "补充"}


def _keywords(text: str) -> list[str]:
    """从文本中提取少量中英文关键词，供 dry-run 关联使用。"""
    stop = {"的", "了", "是", "在", "我", "有", "和", "一个", "什么", "如何", "怎么", "the", "and", "for"}
    words = re.findall(r"[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9_-]{1,15}", text)
    seen: list[str] = []
    for word in words:
        if word.lower() not in stop and word not in seen:
            seen.append(word)
    return seen[:6]


def extract_cards_dry_run(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """不用模型，将连续 user/assistant 消息合成知识卡片。"""
    cards: list[dict[str, Any]] = []
    index = 0
    while index < len(messages):
        current = messages[index]
        if current.get("role") == "user" and index + 1 < len(messages) and messages[index + 1].get("role") == "assistant":
            question = str(current.get("content", "")).strip()
            answer = str(messages[index + 1].get("content", "")).strip()
            index += 2
        else:
            question = str(current.get("content", "")).strip()
            answer = ""
            index += 1
        if not question and not answer:
            continue
        cards.append({
            "id": f"qa-{len(cards) + 1:04d}",
            "title": question[:30] or f"知识卡片 {len(cards) + 1}",
            "category": "其他",
            "summary_q": question[:200],
            "summary_a": answer[:400],
            "keywords": _keywords(question + " " + answer),
            "source": str(current.get("source", "")),
            "_status": "ok",
        })
    return cards


def link_cards_dry_run(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """仅按至少两个关键词重合生成相似关系，不把相邻顺序误判为知识延伸。"""
    links: list[dict[str, Any]] = []
    for index, left in enumerate(cards):
        for right in cards[index + 1:]:
            overlap = sorted(set(left.get("keywords", [])) & set(right.get("keywords", [])))
            if len(overlap) >= 2:
                links.append({
                    "source": left["id"], "target": right["id"], "relation": "相似",
                    "reason": "关键词重合：" + "、".join(overlap[:3]), "confidence": 0.6,
                })
    return links


def _json_from_ollama(endpoint: str, model: str, messages: list[dict[str, str]]) -> dict[str, Any]:
    """调用本地 Ollama JSON 输出接口。"""
    url = endpoint.rstrip("/") + "/api/chat"
    payload = {"model": model, "messages": messages, "stream": False, "format": "json", "options": {"temperature": 0.2}}
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.loads(response.read().decode("utf-8"))
    raw = result.get("message", {}).get("content", "")
    if not raw:
        raise RuntimeError("Ollama 返回空内容")
    return json.loads(raw)


def _json_from_openai(endpoint: str, model: str, messages: list[dict[str, str]], api_key: str) -> dict[str, Any]:
    """调用 OpenAI 兼容云端接口，Key 只存在本次请求内。"""
    if endpoint.rstrip('/').endswith('/chat/completions'):
        url = endpoint.rstrip('/')
    elif endpoint.rstrip('/').endswith('/v1'):
        url = endpoint.rstrip('/') + '/chat/completions'
    else:
        url = endpoint.rstrip('/') + '/v1/chat/completions'
    payload = {"model": model, "messages": messages, "stream": False, "temperature": 0.2,
               "response_format": {"type": "json_object"}}
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.loads(response.read().decode("utf-8"))
    raw = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not raw:
        raise RuntimeError("云端模型返回空内容")
    return json.loads(raw)


def extract_cards(messages: list[dict[str, Any]], provider: str = "dry-run", endpoint: str = "http://127.0.0.1:11434", model: str = "qwen2.5:3b", api_key: str = "") -> list[dict[str, Any]]:
    """按 provider 选择 dry-run、本地 Ollama 或云端 OpenAI 兼容知识卡片提取。"""
    if provider == "dry-run":
        return extract_cards_dry_run(messages)
    if provider == "cloud":
        result = _json_from_openai(endpoint, model, [{"role": "system", "content": "只输出 JSON：{cards:[{title,category,summary_q,summary_a,keywords}]}"}, {"role": "user", "content": json.dumps(messages, ensure_ascii=False)}], api_key)
        cards = result.get("cards", [])
    for index, card in enumerate(cards, 1):
        card.setdefault("id", f"qa-{index:04d}"); card.setdefault("category", "其他"); card.setdefault("keywords", []); card["_status"] = "ok"
        if isinstance(card.get("keywords"), str):
            card["keywords"] = [item.strip() for item in card["keywords"].split(",") if item.strip()]
        return cards
    if provider != "local":
        raise ValueError("支持的 provider：dry-run、local、cloud")
    cards: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") != "user":
            continue
        prompt = [{"role": "system", "content": "只输出 JSON：{title,category,summary_q,summary_a,keywords}"}, {"role": "user", "content": str(message.get("content", ""))}]
        result = _json_from_ollama(endpoint, model, prompt)
        result.update({"id": f"qa-{len(cards) + 1:04d}", "source": message.get("source", ""), "_status": "ok"})
        result.setdefault("keywords", _keywords(str(message.get("content", ""))))
        cards.append(result)
    return cards


def link_cards(cards: list[dict[str, Any]], provider: str = "dry-run", endpoint: str = "http://127.0.0.1:11434", model: str = "qwen2.5:3b", api_key: str = "") -> list[dict[str, Any]]:
    """按 provider 选择 dry-run、本地 Ollama 或云端 OpenAI 兼容语义关联。"""
    if provider == "dry-run":
        return link_cards_dry_run(cards)
    if provider == "cloud":
        result = _json_from_openai(endpoint, model, [{"role": "system", "content": "只输出 JSON：{links:[{source,target,relation,reason}]}"}, {"role": "user", "content": json.dumps(cards, ensure_ascii=False)}], api_key)
    elif provider == "local":
        result = _json_from_ollama(endpoint, model, [{"role": "system", "content": "只输出 JSON：{links:[{source,target,relation,reason}]}"}, {"role": "user", "content": json.dumps(cards, ensure_ascii=False)}])
    else:
        raise ValueError("支持的 provider：dry-run、local、cloud")
    links = []
    valid = {card.get("id") for card in cards}
    seen: set[tuple[str, str]] = set()
    for link in result.get("links", []):
        if link.get("source") in valid and link.get("target") in valid and link.get("source") != link.get("target"):
            key = tuple(sorted((link["source"], link["target"])))
            if key in seen:
                continue
            seen.add(key)
            links.append({"source": link["source"], "target": link["target"], "relation": link.get("relation") if link.get("relation") in RELATIONS else "补充", "reason": str(link.get("reason", ""))[:80], "confidence": link.get("confidence")})
    return links
