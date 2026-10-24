import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location('ocean_refresh', Path(__file__).resolve().parents[1] / 'scripts/refresh.py')
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)
NOW = '2026-10-24T00:00:00Z'
LATER = '2026-10-25T00:00:00Z'


def source(id='rss-ocean', kind='rss', require=False):
    return {'id': id, 'name': 'Ocean source', 'kind': kind,
            'config': {'url': 'https://api.crossref.org/works', 'itemsPath': 'message.items'} if kind == 'json_list' else {'feedUrl': 'https://example.com/feed'},
            'reader': {'requireOceanKeyword': require, 'topics': []}}


RSS = b'''<rss version="2.0"><channel><title>Ocean</title><item>
<title>Ocean heatwave</title><link>https://example.com/ocean?utm_source=feed&amp;x=1#top</link>
<description><![CDATA[<p>Real <b>marine</b> observation.</p><script>alert(1)</script><img src=x onerror="bad()">]]></description>
<pubDate>Fri, 23 Oct 2026 23:30:00 +0800</pubDate></item></channel></rss>'''
ATOM = b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<title>Deep sea coral observation</title><link href="/paper" rel="alternate"/><link href="/edit" rel="edit"/>
<published>2026-10-23T12:00:00-04:00</published><updated>2026-10-24T00:00:00Z</updated>
<summary type="html">&lt;p&gt;Marine coral.&lt;/p&gt;</summary><content>DO NOT REPRINT ARTICLE BODY</content>
</entry></feed>'''


class ParsingTests(unittest.TestCase):
    def test_journal_front_matter_is_not_a_research_story(self):
        s = source('json-ocean', 'json_list')
        for title in ['Editorial Board', 'Journal Information and Table of Contents']:
            self.assertIsNone(reader.make_item(s, title, 'https://doi.org/10.1234/front', '', now=NOW))
        self.assertIsNotNone(reader.make_item(s, 'Marine policy and editorial independence',
                                             'https://doi.org/10.1234/research', '', now=NOW))

    def test_rss_text_dates_and_tracking_url(self):
        item, = reader.parse_feed(RSS, source(), 'https://example.com/feed', 20, NOW)
        self.assertEqual(item['url'], 'https://example.com/ocean?x=1')
        self.assertEqual(item['publishedAt'], '2026-10-23T15:30:00Z')
        self.assertEqual(item['summary'], 'Real marine observation.')
        self.assertNotIn('<', item['summary'])
        self.assertNotIn('alert', item['summary'])
        self.assertEqual(item['collectedAt'], NOW)
        self.assertIn('climate', item['topics'])

    def test_atom_alternate_link_and_no_full_content(self):
        item, = reader.parse_feed(ATOM, source(), 'https://example.com/feed', 20, NOW)
        self.assertEqual(item['url'], 'https://example.com/paper')
        self.assertEqual(item['publishedAt'], '2026-10-23T16:00:00Z')
        self.assertEqual(item['summary'], 'Marine coral.')
        self.assertNotIn('DO NOT REPRINT', json.dumps(item))

    def test_atom_updated_is_not_a_publication_date(self):
        body = ATOM.replace(b'<published>2026-10-23T12:00:00-04:00</published>', b'')
        item, = reader.parse_feed(body, source(), 'https://example.com/feed', 20, NOW)
        self.assertIsNone(item['publishedAt'])

    def test_crossref_configured_paths_doi_and_partial_dates(self):
        s = source('json-ocean', 'json_list')
        s['config'].update(titlePaths=['title.0'], summaryPaths=['abstract'], publishedAtPath='published.date-parts', externalIdPath='DOI', urlTemplate='https://doi.org/{DOI}')
        body = json.dumps({'message': {'items': [
            {'DOI': '10.1234/OCEAN.A', 'title': ['Ocean carbon'], 'abstract': '<jats:p>Marine carbon observation.</jats:p>', 'published': {'date-parts': [[2026, 10, 23]]}},
            {'DOI': '10.1234/OCEAN.B', 'title': ['Marine change'], 'published': {'date-parts': [[2026, 10]]}, 'created': {'date-time': NOW}},
        ]}}).encode()
        full, partial = reader.parse_crossref(body, s, 20, NOW)
        self.assertEqual(full['doi'], '10.1234/ocean.a')
        self.assertEqual(full['publishedAt'], '2026-10-23T00:00:00Z')
        self.assertEqual(full['publishedDatePrecision'], 'day')
        self.assertIsNone(partial['publishedAt'])
        self.assertEqual(partial['publishedDate'], '2026-10')
        self.assertEqual(partial['publishedDatePrecision'], 'month')

    def test_invalid_unknown_dates_do_not_become_now(self):
        for value in [None, '', 'not a date', '2026-10-23T12:00:00', [[2026, 2, 31]], [[2026, 13]], [[0]]]:
            with self.subTest(value=value):
                self.assertEqual(reader.date_value(value), (None, None, None))
        self.assertEqual(reader.date_value([[2026]]), (None, 'year', '2026'))

    def test_general_source_keywords_are_explicit_not_ai_scoring(self):
        general = source('rss-general', require=True)
        self.assertIsNone(reader.make_item(general, 'New research on deserts', 'https://example.com/desert', 'Researchers discuss climate', now=NOW))
        item = reader.make_item(general, 'Marine reef recovery', 'https://example.com/reef', '', now=NOW)
        self.assertTrue(item['ruleMatched'])
        self.assertIn('marine', item['ruleHits'])
        self.assertEqual(item['filterMode'], 'marine-keyword')
        specialist = source()
        specialist['reader']['topics'] = ['physical']
        kept = reader.make_item(specialist, 'New measurement method', 'https://example.com/method', '', now=NOW)
        self.assertFalse(kept['ruleMatched'])
        self.assertEqual(kept['ruleHits'], [])
        self.assertEqual(kept['topics'], ['physical'])

    def test_institution_branding_and_hidden_footer_do_not_establish_subject(self):
        general = source('rss-scripps', require=True)
        general['name'] = 'Scripps Oceanography'
        for excerpt in [
            'NASA is choosing lunar landing sites. Scripps Institution of Oceanography',
            'NASA is choosing lunar landing sites. ' + ('Moon landing research. ' * 20) + 'Ocean exploration footer',
        ]:
            with self.subTest(excerpt=excerpt[:60]):
                self.assertIsNone(reader.make_item(general, 'We are going back to the Moon', 'https://example.com/moon', excerpt, now=NOW))
        marine = reader.make_item(general, 'Researchers measure changing waters', 'https://example.com/water', 'New observations of ocean warming.', now=NOW)
        self.assertIsNotNone(marine)
        self.assertIn('climate', marine['topics'])

    def test_weak_summary_comparison_is_not_marine_subject(self):
        general = source('rss-eos', require=True)
        self.assertIsNone(reader.make_item(general, 'Acid salt lakes reveal unusual chemistry', 'https://example.com/lake', 'These inland lakes can be saltier than seawater.', now=NOW))
        self.assertIsNotNone(reader.make_item(general, 'Seawater chemistry is changing', 'https://example.com/chemistry', 'Measurements of acidity.', now=NOW))
        self.assertIsNotNone(reader.make_item(general, 'New research on water chemistry', 'https://example.com/carbon', 'Measurements of marine carbon cycling.', now=NOW))

    def test_common_plural_keywords_preserve_word_boundaries(self):
        item = reader.make_item(source('rss-general', require=True), 'A simple touch can bring dying corals back', 'https://example.com/corals', 'Sensors measure recovery on reefs.', now=NOW)
        self.assertIsNotNone(item)
        self.assertIn('biology', item['topics'])
        self.assertIn('engineering', item['topics'])
        self.assertIn('coral', item['ruleHits'])
        self.assertEqual(reader.hit_words('coralification sensory reefing', ['coral', 'sensor', 'reef']), [])

    def test_marine_habitats_and_organisms_do_not_require_literal_ocean(self):
        for title in [
            'The origins and dispersal dynamics of a neustonic siphonophore',
            'Amazon River Plume Control on Carbonate Chemistry in the Western Tropical Atlantic',
            'Elevated B-vitamins within a temperate estuary',
            'Saildrone research fleet to circle Antarctica for 5 years',
            'Kelp Help: Meet the Scientists Working to Restore Our Underwater Forests',
        ]:
            with self.subTest(title=title):
                self.assertIsNotNone(reader.make_item(source('rss-general', require=True), title, 'https://example.com/marine', '', now=NOW))

    def test_unsafe_article_links_dropped_and_summary_limited(self):
        for url in ['javascript:alert(1)', 'file:///etc/passwd', 'http://localhost/a', 'http://127.0.0.1/a', 'http://10.0.0.1/a', 'https://user:pw@example.com/a', 'http://[::1]/a', 'http://2130706433/a', 'http://127.1/a', 'http://0x7f000001/a']:
            with self.subTest(url=url):
                self.assertIsNone(reader.make_item(source(), 'Ocean', url, '', now=NOW))
        item = reader.make_item(source(), '<img src=x onerror=bad()>Ocean', 'https://example.com/ocean', 'a' * 500, now=NOW)
        self.assertEqual(item['title'], 'Ocean')
        self.assertEqual(len(item['summary']), 240)

    def test_doctype_and_non_feed_rejected(self):
        for body in [b'<!DOCTYPE rss [<!ENTITY a "boom">]><rss/>', '<!DOCTYPE rss><rss/>'.encode('utf-16'), b'<html><body>not a feed</body></html>']:
            with self.subTest(body=body[:30]), self.assertRaises(ValueError):
                reader.parse_feed(body, source(), 'https://example.com/feed', 20, NOW)

    def test_twenty_item_limit(self):
        body = ('<rss><channel>' + ''.join(f'<item><title>Ocean {n}</title><link>https://example.com/{n}</link></item>' for n in range(40)) + '</channel></rss>').encode()
        self.assertEqual(len(reader.parse_feed(body, source(), 'https://example.com/feed', 20, NOW)), 20)


class ArchiveTests(unittest.TestCase):
    def test_unknown_publication_date_does_not_outrank_dated_news(self):
        known = reader.make_item(source(), 'Ocean observation', 'https://example.com/dated', '',
                                 published='2026-10-23T00:00:00Z', now=NOW)
        unknown = reader.make_item(source(), 'Ocean undated paper', 'https://example.com/undated', '', now=LATER)
        merged = reader.merge_items([], [unknown, known], {'rss-ocean'}, {'rss-ocean': {'status': 'ok'}})
        self.assertEqual(merged[0]['id'], known['id'])
        self.assertIsNone(merged[1]['publishedAt'])

    def test_reapply_rules_preserves_dates_and_only_accepted_provenance(self):
        general = source('general', require=True)
        specialist = source('specialist')
        old = reader.make_item(specialist, 'New measurement method', 'https://example.com/method', '', now=NOW)
        old.update(sourceId='general', sourceName=general['name'],
                   publishedAt=None, publishedDate='2026-09', publishedDatePrecision='month',
                   topics=['physical'], sources=[{'id': 'general', 'name': general['name']}, {'id': 'specialist', 'name': specialist['name']}])
        kept, = reader.reapply_rules([old], [general, specialist])
        self.assertEqual(kept['collectedAt'], NOW)
        self.assertEqual(kept['publishedDate'], '2026-09')
        self.assertEqual(kept['publishedDatePrecision'], 'month')
        self.assertIsNone(kept['publishedAt'])
        self.assertEqual(kept['sourceId'], 'specialist')
        self.assertEqual([p['id'] for p in kept['sources']], ['specialist'])
        self.assertEqual(kept['topics'], [])

    def test_rebuild_is_offline_and_keeps_real_acquisition_timestamps(self):
        s = source('rss-general', require=True)
        data, _ = reader.refresh({'sources': [s]}, fetcher=lambda *a, **kw: (RSS, 'https://example.com/feed'), now=NOW)
        rejected = reader.make_item(source(), 'Research on Moon rocks', 'https://example.com/moon', 'Institution footer: oceanography', now=NOW)
        rejected.update(sourceId=s['id'], sourceName=s['name'], sources=[{'id': s['id'], 'name': s['name']}])
        data['items'].append(rejected)
        data['metadata']['sourceStatus'][0]['itemCount'] = 2
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            config_file = directory / 'config.json'
            config_file.write_text(json.dumps({'sources': [s]}), encoding='utf-8')
            reader.write_outputs(data, directory)
            with patch.object(reader, 'refresh', side_effect=AssertionError('network refresh called')), patch.object(reader, 'timestamp', return_value=LATER):
                result = reader.main(['--config', str(config_file), '--output-dir', str(directory), '--rebuild'])
            self.assertEqual(result, 0)
            rebuilt = json.loads((directory / 'data.json').read_text(encoding='utf-8'))
        self.assertEqual(len(rebuilt['items']), 1)
        self.assertEqual(rebuilt['metadata']['generatedAt'], LATER)
        self.assertEqual(rebuilt['metadata']['ruleRebuiltAt'], LATER)
        self.assertEqual(rebuilt['metadata']['lastSuccessAt'], NOW)
        self.assertEqual(rebuilt['metadata']['lastAttemptAt'], NOW)
        self.assertEqual(rebuilt['metadata']['sourceStatus'][0]['lastSuccessAt'], NOW)
        self.assertEqual(rebuilt['metadata']['sourceStatus'][0]['lastAttemptAt'], NOW)
        self.assertEqual(rebuilt['metadata']['sourceStatus'][0]['itemCount'], 1)
        self.assertEqual(rebuilt['items'][0]['collectedAt'], NOW)

    def test_same_url_and_doi_deduplicate_keep_first_collection(self):
        a = reader.make_item(source('a'), 'Ocean original', 'https://example.com/paper?utm_source=a', '', now=NOW)
        b = reader.make_item(source('b'), 'Ocean corrected', 'https://example.com/paper#fragment', '', now=LATER)
        rows = reader.merge_items([a], [b], {'a', 'b'}, {'a': {'status': 'stale'}, 'b': {'status': 'ok'}})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['id'], a['id'])
        self.assertEqual(rows[0]['collectedAt'], NOW)
        self.assertFalse(rows[0]['stale'])
        self.assertEqual([s['id'] for s in rows[0]['sources']], ['a', 'b'])
        d1 = reader.make_item(source('a'), 'Ocean', 'https://doi.org/10.1234/ABC', '', now=NOW)
        d2 = reader.make_item(source('b'), 'Ocean', 'https://publisher.example/paper', '', doi='doi:10.1234/abc', now=LATER)
        self.assertEqual(d1['id'], d2['id'])

    def test_failure_preserves_archive_and_actual_success_time(self):
        config = {'sources': [source()]}
        first, status = reader.refresh(config, fetcher=lambda *a, **kw: (RSS, 'https://example.com/feed'), now=NOW)
        self.assertEqual(status, 0)
        def fail(*args, **kwargs):
            raise TimeoutError('source timed out')
        failed, status = reader.refresh(config, first, fetcher=fail, now=LATER)
        self.assertEqual(status, 1)
        self.assertEqual(len(failed['items']), 1)
        self.assertEqual(failed['items'][0]['id'], first['items'][0]['id'])
        self.assertEqual(failed['items'][0]['collectedAt'], NOW)
        self.assertTrue(failed['items'][0]['stale'])
        self.assertEqual(failed['metadata']['lastSuccessAt'], NOW)
        state, = failed['metadata']['sourceStatus']
        self.assertEqual(state['status'], 'stale')
        self.assertEqual(state['lastSuccessAt'], NOW)
        self.assertEqual(state['lastAttemptAt'], LATER)

    def test_manual_sources_never_fetched_and_empty_success_keeps_history(self):
        manual = source('manual', 'external')
        manual['reader']['homepage'] = 'https://example.com/manual'
        config = {'sources': [source(), manual]}
        calls = []
        def fetch(*a, **kw):
            calls.append(a[0]); return RSS, 'https://example.com/feed'
        first, _ = reader.refresh(config, fetcher=fetch, now=NOW)
        self.assertEqual(len(calls), 1)
        self.assertEqual(first['metadata']['sourceStatus'][1]['status'], 'manual')
        self.assertEqual(first['sources'][1]['url'], 'https://example.com/manual')
        second, status = reader.refresh(config, first, fetcher=lambda *a, **kw: (b'<rss><channel/></rss>', 'https://example.com/feed'), now=LATER)
        self.assertEqual(status, 0)
        self.assertEqual(len(second['items']), 1)
        self.assertEqual(second['metadata']['lastSuccessAt'], LATER)

    def test_identical_run_is_idempotent_and_outputs_are_real_rss(self):
        config = {'sources': [source()], 'siteUrl': 'https://example.com/ocean/'}
        fetch = lambda *a, **kw: (RSS, 'https://example.com/feed')
        first, _ = reader.refresh(config, fetcher=fetch, now=NOW)
        second, _ = reader.refresh(config, first, fetcher=fetch, now=NOW)
        self.assertEqual(first, second)
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            reader.write_outputs(first, directory)
            saved = json.loads((directory / 'data.json').read_text(encoding='utf-8'))
            self.assertEqual(saved, first)
            channel = ET.parse(directory / 'feed.xml').getroot().find('channel')
            for required in ['title', 'description', 'link']:
                self.assertTrue(channel.findtext(required))
            self.assertEqual(channel.findtext('link'), 'https://example.com/ocean/')
            self.assertEqual(channel.findtext('item/link'), first['items'][0]['url'])
            self.assertEqual(channel.find('item/source').get('url'), 'https://example.com/feed')
            self.assertFalse(channel.find('item/guid').get('isPermaLink') == 'true')
            self.assertEqual((directory / 'sources.opml').read_bytes(), (directory / 'ocean-sources.opml').read_bytes())
            self.assertEqual(len(ET.parse(directory / 'ocean-sources.opml').findall('.//outline')), 1)

    def test_no_site_url_is_explicitly_unconfigured(self):
        data, _ = reader.refresh({'sources': []}, now=NOW)
        self.assertIsNone(data['metadata']['siteUrl'])
        self.assertFalse(data['metadata']['feedUrlConfigured'])
        self.assertIsNone(data['metadata']['lastSuccessAt'])


class NetworkBoundaryTests(unittest.TestCase):
    def test_private_dns_resolution_rejected_before_connect(self):
        with patch.object(reader.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 80))]):
            with self.assertRaisesRegex(ValueError, 'non-public'):
                reader.resolve_public('example.com', 80, reader.time.monotonic() + 1)

    def test_redirect_to_private_address_rejected(self):
        response = Mock(status=302)
        response.getheader.side_effect = lambda name: 'http://127.0.0.1/admin' if name == 'Location' else None
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(reader, 'resolve_public', return_value=[(2, 1, 6, '', ('93.184.216.34', 80))]), patch.object(reader.socket, 'socket', return_value=Mock()), patch.object(reader.http.client, 'HTTPConnection', return_value=connection):
            with self.assertRaisesRegex(ValueError, 'forbidden'):
                reader.fetch_public('http://example.com/feed')

    def test_body_size_and_gzip_expansion_limits(self):
        for compressed in [False, True]:
            response = Mock(status=200)
            response.isclosed.return_value = False
            blob = gzip.compress(b'x' * 1000) if compressed else b'x' * 1000
            response.getheader.side_effect = lambda name: ('gzip' if compressed else None) if name == 'Content-Encoding' else (str(len(blob)) if name == 'Content-Length' else None)
            response.read.side_effect = [blob, b'']
            connection = Mock()
            connection.getresponse.return_value = response
            with patch.object(reader, 'resolve_public', return_value=[(2, 1, 6, '', ('93.184.216.34', 80))]), patch.object(reader.socket, 'socket', return_value=Mock()), patch.object(reader.http.client, 'HTTPConnection', return_value=connection):
                with self.assertRaisesRegex(ValueError, 'byte limit'):
                    reader.fetch_public('http://example.com/feed', max_bytes=100)

    def test_content_length_eof_closes_socket_before_another_timeout_update(self):
        # Reproduce Windows HTTPResponse ownership: reading the final body closes the socket.
        state = {'closed': False}
        sock = Mock()
        def settimeout(value):
            if state['closed']:
                raise OSError('WinError10038: operation on a closed socket')
        sock.settimeout.side_effect = settimeout
        response = Mock(status=200)
        response.getheader.side_effect = lambda name: '6' if name == 'Content-Length' else None
        response.isclosed.side_effect = lambda: state['closed']
        def read(size):
            state['closed'] = True
            return b'<rss/>'
        response.read.side_effect = read
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(reader, 'resolve_public', return_value=[(2, 1, 6, '', ('93.184.216.34', 80))]), patch.object(reader.socket, 'socket', return_value=sock), patch.object(reader.http.client, 'HTTPConnection', return_value=connection):
            body, final = reader.fetch_public('http://example.com/feed')
        self.assertEqual(body, b'<rss/>')
        self.assertEqual(response.read.call_count, 1)


if __name__ == '__main__':
    unittest.main()
