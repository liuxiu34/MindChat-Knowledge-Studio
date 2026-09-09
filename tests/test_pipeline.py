import unittest

from bridge.pipeline import extract_cards_dry_run, link_cards_dry_run


class PipelineTests(unittest.TestCase):
    def test_extract_pairs_messages(self):
        cards = extract_cards_dry_run([
            {"role": "user", "content": "什么是模型路由？"},
            {"role": "assistant", "content": "按任务选择模型。"},
            {"role": "user", "content": "Luna 适合什么？"},
            {"role": "assistant", "content": "适合轻量提取。"},
        ])
        self.assertEqual(2, len(cards))
        self.assertEqual("什么是模型路由？", cards[0]["summary_q"])

    def test_link_only_semantic_overlap(self):
        cards = [
            {"id": "a", "keywords": ["模型", "路由"]},
            {"id": "b", "keywords": ["模型", "路由"]},
            {"id": "c", "keywords": ["Luna", "提取"]},
        ]
        links = link_cards_dry_run(cards)
        self.assertEqual(1, len(links))
        self.assertEqual("相似", links[0]["relation"])


if __name__ == "__main__":
    unittest.main()
