import json
import unittest
from unittest.mock import patch

from bridge.pipeline import _json_from_openai, link_cards


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class CloudRouteTests(unittest.TestCase):
    def test_openai_compatible_auth_is_request_only(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured['url'] = request.full_url
            captured['auth'] = request.headers.get('Authorization')
            return FakeResponse({'choices': [{'message': {'content': '{"links": []}'}}]})

        with patch('bridge.pipeline.urllib.request.urlopen', side_effect=fake_urlopen):
            result = _json_from_openai('http://example.test/v1', 'gpt-test', [], 'secret-test-key')
        self.assertEqual([], result['links'])
        self.assertEqual('http://example.test/v1/chat/completions', captured['url'])
        self.assertEqual('Bearer secret-test-key', captured['auth'])

    def test_cloud_link_route(self):
        payload = {'choices': [{'message': {'content': '{"links": [{"source": "a", "target": "b", "relation": "依赖", "reason": "测试"}]}'}}]}
        with patch('bridge.pipeline.urllib.request.urlopen', return_value=FakeResponse(payload)):
            links = link_cards([{'id': 'a'}, {'id': 'b'}], provider='cloud', endpoint='http://example.test/v1', model='gpt-test', api_key='secret')
        self.assertEqual(1, len(links))
        self.assertEqual('依赖', links[0]['relation'])


if __name__ == '__main__':
    unittest.main()
