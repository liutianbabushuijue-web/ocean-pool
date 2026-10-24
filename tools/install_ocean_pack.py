#!/usr/bin/env python3
"""Install the portable ocean pack into an existing AIHOT checkout, with backups.

Dry runs never write files or generate secrets. Existing modules and credentials
are preserved. This command never starts services or calls a paid provider.
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import shutil
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PACK = ROOT if (ROOT / 'industry').is_dir() else ROOT / 'ocean-pack'
REGISTRIES = {
    'index.ts': ('MODULES', '@aihot/stepx-push/module'),
    'server.ts': ('SERVER_MODULES', '@aihot/stepx-push'),
    'web.ts': ('WEB_MODULES', '@aihot/stepx-push/web'),
}


def registry(source: str, variable: str, package: str) -> str:
    """Append to a literal registry; reject unfamiliar expressions before writing."""
    match = re.search(r'(export\s+const\s+' + variable + r'\b[^=]*=\s*\[)([\s\S]*?)(\])', source)
    if not match:
        raise ValueError(f'{variable}: expected a literal module array; merge it manually before installing')
    body = re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', '', match[2]).strip()
    if body and not re.fullmatch(r'[\w$]+(?:\s*,\s*[\w$]+)*\s*,?', body):
        raise ValueError(f'{variable}: nonliteral registry, refusing to replace existing modules')
    imported = re.search(r'import\s+([\w$]+)\s+from\s+[\'"]' + re.escape(package) + r'[\'"]', source)
    name = imported[1] if imported else 'oceanStepxPush'
    if not imported and re.search(r'\b' + name + r'\b', source):
        raise ValueError(f'{variable}: import name conflict')
    members = re.findall(r'[\w$]+', body)
    if name not in members:
        separator = '' if not body else ('' if match[2].rstrip().endswith(',') else ',')
        replacement = match[2].rstrip() + separator + (' ' if body else '') + name
        source = source[:match.start(2)] + replacement + source[match.end(2):]
    if not imported:
        source = f'import {name} from "{package}";\n' + source
    return source


def dockerfile(text: str) -> str:
    line = 'COPY modules/stepx-push/package.json modules/stepx-push/'
    if line in text:
        return text
    marker = re.search(r'^COPY site/package\.json site/\s*$', text, re.M)
    if not marker:
        raise ValueError('Dockerfile: missing known site/package.json COPY anchor; no files were changed')
    return text[:marker.end()] + '\n' + line + text[marker.end():]


def compose(text: str) -> str:
    section = re.search(r'^  web:\s*\n[\s\S]*?(?=^  [\w-]+:|^volumes:|\Z)', text, re.M)
    if not section:
        raise ValueError('docker-compose.yml: missing web service; no files were changed')
    block = section[0]
    if re.search(r'^      ADMIN_SYNC_TOKEN:', block, re.M):
        return text
    anchor = re.search(r'^    environment:\s*\n', block, re.M)
    if not anchor or re.search(r'^      - ', block[anchor.end():], re.M):
        raise ValueError('docker-compose.yml: unsupported web environment format; no files were changed')
    block = block[:anchor.end()] + '      ADMIN_SYNC_TOKEN: ${ADMIN_SYNC_TOKEN:-}\n' + block[anchor.end():]
    return text[:section.start()] + block + text[section.end():]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--target', required=True, type=Path)
    ap.add_argument('--pack', type=Path, default=DEFAULT_PACK)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--keep-site', action='store_true')
    args = ap.parse_args()
    target, pack = args.target.resolve(), args.pack.resolve()
    try:
        pkg = json.loads((target / 'package.json').read_text(encoding='utf-8'))
        if 'industry' not in pkg.get('workspaces', []) or not (target / 'site').is_dir():
            raise ValueError('target must be an existing AIHOT checkout')
        if not all((pack / part).is_dir() for part in ('industry', 'site', 'modules/stepx-push')):
            raise ValueError('pack is incomplete: industry/, site/ and modules/stepx-push/ are required')

        # Build and validate the entire plan before mutating the checkout.
        planned: dict[str, bytes] = {}
        excluded = {'package.json', *(f'modules/{name}' for name in REGISTRIES)}
        for part in ('industry', 'site', 'modules/stepx-push'):
            if part == 'site' and args.keep_site:
                continue
            for source in sorted((pack / part).rglob('*')):
                if not source.is_file() or '__pycache__' in source.parts:
                    continue
                rel = source.relative_to(pack / part).as_posix()
                if part == 'site' and rel in excluded:
                    continue
                planned[f'{part}/{rel}'] = source.read_bytes()

        for file, (variable, package) in REGISTRIES.items():
            rel = f'site/modules/{file}'
            source = target / rel if (target / rel).exists() else pack / rel
            planned[rel] = registry(source.read_text(encoding='utf-8'), variable, package).encode('utf-8')
        site_pkg_path = target / 'site/package.json'
        site_pkg = json.loads((site_pkg_path if site_pkg_path.exists() else pack / 'site/package.json').read_text(encoding='utf-8'))
        site_pkg.setdefault('dependencies', {})['@aihot/stepx-push'] = '*'
        planned['site/package.json'] = (json.dumps(site_pkg, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        for rel, patch in [('Dockerfile', dockerfile), ('docker-compose.yml', compose)]:
            if (target / rel).exists():
                planned[rel] = patch((target / rel).read_text(encoding='utf-8')).encode('utf-8')

        env_path = target / '.env'
        env = env_path.read_text(encoding='utf-8') if env_path.exists() else ''
        missing = []
        for key in ('STEPX_TOKEN', 'INGEST_TOKEN', 'ADMIN_SYNC_TOKEN'):
            values = re.findall(r'^\s*(?:export\s+)?' + key + r'\s*=\s*([^\n\r]*)', env, re.M)
            if not values or not values[-1].split(' #', 1)[0].strip().strip('\'"'):
                missing.append(key)
        if missing and not args.dry_run:
            env += '\n# ocean-pack server credentials; never commit this file\n'
            env += ''.join(f'{key}={secrets.token_urlsafe(32)}\n' for key in missing)
            planned['.env'] = env.encode('utf-8')

        changed = {rel: value for rel, value in planned.items() if not (target / rel).exists() or (target / rel).read_bytes() != value}
        print(f'Target: {target}\nPack: {pack}')
        for rel in changed:
            print(f'  {"would update" if args.dry_run else "update"}: {rel}')
        if missing:
            print(('Would create' if args.dry_run else 'Created') + ' server-only credentials: ' + ', '.join(missing) + ' (values hidden)')
        if args.dry_run:
            print('Dry run only: no writes and no secret generation.')
            return 0
        backup = target / '.ocean-pack-backup' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        for rel, value in changed.items():
            path = target / rel
            if path.exists():
                saved = backup / rel
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, saved)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        print(f'Updated {len(changed)} files. Existing credentials and modules preserved.')
        if backup.exists():
            print(f'Backup: {backup}')
        print('Next: npm install; node scripts/migrate.ts; docker compose up -d --build')
        return 0
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f'Installation stopped: {error}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
