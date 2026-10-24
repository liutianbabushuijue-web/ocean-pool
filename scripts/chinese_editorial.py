"""Apply saved AI editorial results only to the exact original input. No model calls."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

BASES = {'abstract', 'source_excerpt', 'title_only'}
FIELDS = ('titleZh', 'summaryZh', 'editorial')


def input_hash(item: dict) -> str:
    return hashlib.sha256((str(item.get('title', '')) + '\n' + str(item.get('summary', ''))).encode('utf-8')).hexdigest()


def valid_text(value, limit: int) -> bool:
    return (isinstance(value, str) and 0 < len(value.strip()) <= limit
            and not re.search(r'[<>\x00-\x1f\x7f]', value)
            and bool(re.search(r'[\u3400-\u9fff]', value)))


def load_editorial(path: Path) -> dict | None:
    if not path.is_file():
        return None
    if path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError('Chinese editorial file exceeds 5 MiB')
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(data, dict) or data.get('schemaVersion') != 1 or not isinstance(data.get('items'), list):
        raise ValueError('Chinese editorial file has unsupported schema')
    if len(data['items']) > 20000 or not isinstance(data.get('promptVersion'), str):
        raise ValueError('Chinese editorial file has invalid entry count or prompt version')
    return data


def apply_editorial(data: dict, editorial: dict | None) -> dict:
    """Never replace raw title/summary used by relevance rules and acquisition."""
    metadata = dict(data['metadata'])
    metadata.pop('editorial', None)
    entries, duplicates, invalid = {}, set(), 0
    if editorial is not None:
        for entry in editorial['items']:
            if not isinstance(entry, dict) or not isinstance(entry.get('id'), str):
                invalid += 1
                continue
            identity = entry['id']
            if identity in entries or identity in duplicates:
                duplicates.add(identity)
                entries.pop(identity, None)
                invalid += 1
                continue
            if (not re.fullmatch(r'[0-9a-f]{64}', str(entry.get('inputHash', '')))
                    or not valid_text(entry.get('titleZh'), 120)
                    or not valid_text(entry.get('summaryZh'), 500)
                    or entry.get('basis') not in BASES):
                invalid += 1
                continue
            entries[identity] = entry
    items, localized = [], 0
    for original in data['items']:
        item = {key: value for key, value in original.items() if key not in FIELDS}
        entry = entries.get(item['id'])
        if entry and entry['inputHash'] == input_hash(item):
            item.update(titleZh=entry['titleZh'].strip(), summaryZh=entry['summaryZh'].strip(),
                        editorial={'basis': entry['basis'], 'inputHash': entry['inputHash'],
                                   'promptVersion': editorial['promptVersion'],
                                   'generatedAt': editorial.get('generatedAt'), 'method': 'ai-translation-summary'})
            localized += 1
        items.append(item)
    if editorial is not None:
        metadata['editorial'] = {'enabled': True, 'promptVersion': editorial['promptVersion'],
                                 'generatedAt': editorial.get('generatedAt'), 'localizedCount': localized,
                                 'pendingCount': len(items) - localized, 'invalidEntries': invalid,
                                 'notice': 'Chinese translation and summary; not selection scoring or fact verification.'}
    return {**data, 'metadata': metadata, 'items': items}
