import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { safeHttpUrl, normalizeItem, validateBookmarkImport, filterItems, formatDate } from '../site/app.js';

const item = { id:'doi:10.1/ocean', title:'Ocean heatwave observation', url:'https://example.org/ocean', sourceId:'noaa', sourceName:'NOAA', publishedAt:'2026-10-23T18:00:00Z', collectedAt:'2026-10-24T00:00:00Z', summary:'Marine observations in the Pacific.', topics:['climate','physical'], ruleMatched:true, ruleHits:['ocean'] };

test('links preserve public HTTP(S) while refusing executable, credential and private destinations', () => {
  assert.equal(safeHttpUrl(item.url), item.url);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/secret', 'https://user:pass@example.org', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.1', 'http://172.18.1.1', 'http://192.168.1.1', 'https://example.local']) assert.equal(safeHttpUrl(url), null, url);
});

test('untrusted feed text remains literal and unsupported topics are removed', () => {
  const normalized = normalizeItem({...item, title:'<img src=x onerror=alert(1)>', summary:'<script>alert(1)</script>', topics:['climate','unknown','climate']});
  assert.equal(normalized.title, '<img src=x onerror=alert(1)>');
  assert.equal(normalized.summary, '<script>alert(1)</script>');
  assert.deepEqual(normalized.topics,['climate']);
  const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('.innerHTML'));
  assert.ok(!source.includes('insertAdjacentHTML'));
});

test('bookmark import rejects invalid batches before any merge and deduplicates valid records', () => {
  assert.throws(()=>validateBookmarkImport({schema:'ocean-bookmarks.v1',bookmarks:[item,{...item,id:'bad',url:'javascript:alert(1)'}]}));
  assert.throws(()=>validateBookmarkImport({schema:'unknown',bookmarks:[item]}));
  assert.equal(validateBookmarkImport({schema:'ocean-bookmarks.v1',bookmarks:[item,item]}).length,1);
  assert.throws(()=>validateBookmarkImport({schema:'ocean-bookmarks.v1',bookmarks:Array(1001).fill(item)}));
});

test('search combines words, source and topics with local read and saved state', () => {
  const other = {...item,id:'other',sourceId:'unesco',sourceName:'UNESCO',topics:['policy'],title:'Ocean treaty'};
  const items = [normalizeItem(item),normalizeItem(other)];
  assert.deepEqual(filterItems(items,{query:'ocean NOAA',topic:'climate',source:'noaa'}).map(v=>v.id),[item.id]);
  assert.deepEqual(filterItems(items,{view:'unread',readIds:new Set([item.id])}).map(v=>v.id),['other']);
  assert.deepEqual(filterItems(items,{view:'saved',savedIds:new Set(['other'])}).map(v=>v.id),['other']);
});

test('display uses Beijing calendar day and does not fabricate absent or invalid dates', () => {
  assert.match(formatDate('2026-10-23T18:00:00Z'),/2026\/10\/24/);
  assert.equal(formatDate(null),'日期未提供');
  assert.equal(formatDate('2026-02-30T00:00:00Z'),'日期未提供');
  assert.equal(formatDate('2026-10-23T18:00:00'),'日期未提供');
});

test('Chinese editorial survives bookmark roundtrips and remains searchable in either language', () => {
  const localized = normalizeItem({...item, titleZh:'海洋热浪观测的新发现', summaryZh:'研究关注太平洋海洋热浪的观测资料。', editorial:{basis:'abstract'}});
  assert.equal(localized.title,'海洋热浪观测的新发现');
  assert.equal(localized.titleOriginal,item.title);
  assert.equal(localized.summary,'研究关注太平洋海洋热浪的观测资料。');
  assert.equal(normalizeItem(JSON.parse(JSON.stringify(localized))).title,localized.title);
  assert.equal(filterItems([localized],{query:'heatwave'}).length,1);
  assert.equal(filterItems([localized],{query:'热浪'}).length,1);
  assert.equal(validateBookmarkImport({schema:'ocean-bookmarks.v1',bookmarks:[localized]})[0].editorialBasis,'abstract');
});

test('Chinese-only mode holds untranslated items while an explicit original view retains access', () => {
  const pending=normalizeItem(item);
  const ready=normalizeItem({...item,id:'translated',titleZh:'海洋热浪观测',summaryZh:'原文关注海洋热浪的观测。',editorial:{basis:'title_only'}});
  assert.deepEqual(filterItems([pending,ready],{onlyChinese:true}).map(v=>v.id),['translated']);
  assert.equal(filterItems([pending,ready],{onlyChinese:false}).length,2);
  assert.equal(ready.editorialBasis,'title_only');
  const unsafe=normalizeItem({...item,titleZh:'<b>海洋</b>',summaryZh:'摘要。',editorial:{basis:'abstract'}});
  assert.equal(unsafe.localized,false);
});
