"""Evidence binding and export checks; these do not call a model or the network."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('chinese_test_reader', ROOT / 'scripts/refresh.py')
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)
editorial = reader._editorial


def fixture():
    return {'schemaVersion': 1, 'metadata': {'lastSuccessAt': '2026-10-24T08:54:10Z'},
            'items': [{'id': 'paper1', 'title': 'Marine coral observation', 'summary': 'Source abstract about coral.',
                       'url': 'https://example.com/paper', 'sourceId': 'rss1', 'sourceName': 'Marine source',
                       'topics': ['biology'], 'publishedAt': None}],
            'sources': [{'id': 'rss1', 'name': 'Marine source', 'kind': 'rss', 'url': 'https://example.com/feed'}]}


def mapping(data):
    return {'schemaVersion': 1, 'promptVersion': 'chinese-reader-v1', 'generatedAt': '2026-10-24T14:00:00Z',
            'items': [{'id': 'paper1', 'inputHash': editorial.input_hash(data['items'][0]),
                       'titleZh': '海洋珊瑚观测研究', 'summaryZh': '这项研究关注海洋珊瑚的观测。', 'basis': 'abstract'}]}


class ChineseEditorialTests(unittest.TestCase):
    def test_raw_inputs_and_source_times_are_preserved(self):
        data = fixture()
        localized = editorial.apply_editorial(data, mapping(data))
        item = localized['items'][0]
        self.assertEqual(item['title'], data['items'][0]['title'])
        self.assertEqual(item['summary'], data['items'][0]['summary'])
        self.assertEqual(item['url'], data['items'][0]['url'])
        self.assertEqual(item['titleZh'], '海洋珊瑚观测研究')
        self.assertEqual(localized['metadata']['lastSuccessAt'], data['metadata']['lastSuccessAt'])
        self.assertEqual(localized['metadata']['editorial']['localizedCount'], 1)
        self.assertNotIn('titleZh', data['items'][0])

    def test_changed_source_or_invalid_editorial_cannot_reuse_summary(self):
        data = fixture()
        saved = mapping(data)
        changed = copy.deepcopy(data)
        changed['items'][0]['summary'] += ' Corrected result.'
        pending = editorial.apply_editorial(changed, saved)
        self.assertNotIn('titleZh', pending['items'][0])
        self.assertEqual(pending['metadata']['editorial']['pendingCount'], 1)
        for update in [{'inputHash': '0' * 64}, {'titleZh': '<b>海洋标题</b>'}, {'titleZh': 'English title'},
                       {'summaryZh': '海' * 501}, {'basis': 'full_article_claim'}]:
            invalid = copy.deepcopy(saved)
            invalid['items'][0].update(update)
            self.assertNotIn('titleZh', editorial.apply_editorial(data, invalid)['items'][0])

    def test_duplicate_ids_are_not_silently_resolved(self):
        data = fixture()
        saved = mapping(data)
        saved['items'].append(dict(saved['items'][0]))
        self.assertNotIn('titleZh', editorial.apply_editorial(data, saved)['items'][0])

    def test_reload_or_map_removal_does_not_keep_unbound_output(self):
        data = fixture()
        localized = editorial.apply_editorial(data, mapping(data))
        reloaded = json.loads(json.dumps(localized))
        self.assertEqual(editorial.apply_editorial(reloaded, mapping(data)), localized)
        cleared = editorial.apply_editorial(reloaded, None)
        self.assertNotIn('titleZh', cleared['items'][0])
        self.assertNotIn('editorial', cleared['metadata'])

    def test_chinese_rss_uses_direct_original_link_and_holds_pending(self):
        data = fixture()
        data['items'].append({**data['items'][0], 'id': 'pending', 'title': 'Untranslated ocean news'})
        saved = mapping(data)
        saved['items'][0]['basis'] = 'title_only'
        saved['items'][0]['summaryZh'] = '来源未提供摘要，具体方法与结果需查看原文。'
        localized = editorial.apply_editorial(data, saved)
        with tempfile.TemporaryDirectory() as folder:
            reader.write_outputs(localized, Path(folder))
            entries = ET.parse(Path(folder) / 'feed.xml').findall('./channel/item')
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].findtext('title'), '海洋珊瑚观测研究')
            self.assertEqual(entries[0].findtext('link'), 'https://example.com/paper')
            self.assertIn('仅据标题', entries[0].findtext('description'))

    def test_malformed_mapping_is_rejected_before_overwriting_data(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'chinese-editorial.json'
            self.assertIsNone(editorial.load_editorial(path))
            path.write_text('{"schemaVersion":2,"items":[]}', encoding='utf-8')
            with self.assertRaises(ValueError):
                editorial.load_editorial(path)


if __name__ == '__main__':
    unittest.main()
