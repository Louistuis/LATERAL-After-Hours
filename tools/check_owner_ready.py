#!/usr/bin/env python3
"""Check declared QA evidence integrity. Does NOT execute or certify game tests.

Standard library only. Every PASS must be backed by real, independently reviewed
execution; this checker cannot determine whether a report's prose is truthful.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile
from typing import Any

AGENTS = {'A0', 'S1', 'S2', 'S3', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'}
SHA256 = re.compile(r'^[0-9a-f]{64}$')

def validate(manifest: dict[str, Any], root: Path, gates: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    root = root.resolve()
    seen_evidence: dict[str, str] = {}
    def check(ok: Any, message: str) -> None:
        if not ok:
            errors.append(message)
    def nonblank(value: Any) -> bool:
        return isinstance(value, str) and bool(value.strip())
    def artifact(item: Any, context: str) -> Path | None:
        if not isinstance(item, dict):
            errors.append(f'{context}: artifact object required')
            return None
        name, digest = item.get('path'), item.get('sha256')
        if not nonblank(name) or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            errors.append(f'{context}: relative path and actual SHA-256 required')
            return None
        p = Path(name)
        if p.is_absolute() or '..' in p.parts:
            errors.append(f'{context}: artifact path must remain inside root')
            return None
        p = (root / p).resolve()
        if not p.is_relative_to(root):
            errors.append(f'{context}: artifact path escapes root')
            return None
        if not p.is_file() or p.stat().st_size == 0:
            errors.append(f'{context}: missing or empty artifact {name}')
            return None
        with p.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        check(actual == digest, f'{context}: SHA-256 mismatch for {name}')
        old = seen_evidence.get(str(p))
        check(old is None or old == digest, f'{context}: conflicting evidence hashes')
        seen_evidence[str(p)] = digest
        return p
    def evidence(item: dict[str, Any], context: str) -> set[str]:
        rows = item.get('evidence')
        if not isinstance(rows, list) or not rows:
            errors.append(f'{context}: nonempty evidence list required')
            return set()
        found = set()
        for row in rows:
            p = artifact(row, context)
            if p is not None:
                found.add(str(p))
        return found
    def identity(item: dict[str, Any], context: str) -> None:
        check(item.get('build_id') == build, f'{context}: build identity mismatch')
        check(item.get('commit') == commit, f'{context}: commit mismatch')
    def independent(item: dict[str, Any], context: str) -> None:
        check(item.get('author') in AGENTS, f'{context}: actual author slot required')
        check(item.get('reviewer') in AGENTS, f'{context}: reviewer slot required')
        check(item.get('author') != item.get('reviewer'), f'{context}: self-review is forbidden')

    try:
        check(manifest.get('schema_version') == 1, 'Unsupported QA manifest schema')
        check(manifest.get('status') == 'PASS', 'Manifest is not PASS')
        policy = gates['owner_review']
        candidate = manifest['candidate']
        build, commit = candidate.get('build_id'), candidate.get('commit')
        check(nonblank(build) and nonblank(commit), 'Actual candidate build and commit required')
        check(nonblank(candidate.get('version')), 'Actual candidate version required')
        check(isinstance(candidate.get('content_hash'), str) and SHA256.fullmatch(candidate['content_hash']),
              'Actual content manifest SHA-256 required')
        check(candidate.get('target') == policy['candidate_target'], 'Candidate target must be owner-review')
        candidate_path = artifact(candidate.get('artifact'), 'Candidate')
        candidate_sha = candidate.get('artifact', {}).get('sha256')
        if candidate_path is not None:
            check(zipfile.is_zipfile(candidate_path), 'Candidate must be the prebuilt playable ZIP')
            if zipfile.is_zipfile(candidate_path):
                with zipfile.ZipFile(candidate_path) as z:
                    names = z.namelist()
                    check(all(not n.startswith('/') and '..' not in Path(n).parts for n in names),
                          'Candidate ZIP has an unsafe member path')
                    check(any(Path(n).name == 'index.html' for n in names),
                          'Candidate ZIP lacks a browser entry point')
                    check(z.testzip() is None, 'Candidate ZIP CRC check failed')
        reqs = manifest.get('requirements')
        if not isinstance(reqs, list):
            errors.append('Requirements must be a list')
            reqs = []
        reqmap = {r['id']: r for r in reqs}
        check(len(reqmap) == len(reqs), 'Duplicate requirement result IDs')
        required = set(policy['required_acceptance_ids'])
        check(required <= set(reqmap), f'Missing required results: {sorted(required - set(reqmap))}')
        for rid in required & set(reqmap):
            row = reqmap[rid]
            check(row.get('status') == 'PASS', f'{rid}: mandatory requirement is not PASS')
            identity(row, rid)
            independent(row, rid)
            evidence(row, rid)
        runs = manifest.get('clean_regression_runs')
        if not isinstance(runs, list):
            errors.append('Regression runs must be a list')
            runs = []
        check(len(runs) >= policy['clean_core_regression_runs_min'], 'Two clean core-regression runs required')
        run_ids: set[str] = set()
        run_paths: list[set[str]] = []
        real_browser_runs = 0
        for row in runs:
            rid = row.get('id')
            check(nonblank(rid) and rid not in run_ids, 'Regression run IDs must be distinct')
            run_ids.add(rid)
            context = f'Regression {rid}'
            check(row.get('status') == 'PASS', f'{context}: not PASS')
            check(row.get('mandatory_failed') == 0 and row.get('mandatory_skipped') == 0,
                  f'{context}: mandatory cases failed or skipped')
            check(row.get('fresh_profile') is True, f'{context}: fresh browser profile required')
            check(row.get('candidate_sha256') == candidate_sha, f'{context}: candidate artifact mismatch')
            identity(row, context)
            independent(row, context)
            paths = evidence(row, context)
            check(all(paths != old for old in run_paths), f'{context}: reused regression evidence set')
            run_paths.append(paths)
            env = row.get('environment', {})
            for field in ['browser', 'browser_version', 'os', 'hardware', 'graphics_backend', 'kind']:
                check(nonblank(env.get(field)), f'{context}: actual environment {field} required')
            if env.get('kind') == 'real-browser' and row.get('real_input_driven') is True:
                real_browser_runs += 1
        check(real_browser_runs >= 1, 'At least one real-browser, input-driven core regression required')
        reviews = manifest.get('independent_reviews')
        if not isinstance(reviews, list):
            errors.append('Independent department reviews must be a list')
            reviews = []
        departments: set[str] = set()
        for row in reviews:
            dep = row.get('department_id')
            check(dep not in departments, 'Duplicate department review')
            departments.add(dep)
            context = f'Department {dep}'
            check(row.get('status') == 'PASS', f'{context}: not PASS')
            identity(row, context)
            independent(row, context)
            evidence(row, context)
        check(set(policy['department_reviewers']) <= departments, 'S1/S2/S3 department reviews required')
        bugs = manifest.get('open_defects')
        if not isinstance(bugs, list):
            errors.append('Open defects must be an explicit list')
            bugs = []
        for bug in bugs:
            sev = bug.get('severity')
            check(sev in {'P0','P1','P2','P3'}, 'Invalid defect severity')
            check(sev not in policy['open_defects_max'], f'Open {sev} defect blocks owner readiness')
            check(nonblank(bug.get('id')) and nonblank(bug.get('summary')), 'Defect ID/summary required')
        final = manifest['astra_review']
        check(final.get('agent_id') == 'A0' and final.get('status') == 'PASS', 'Final A0 approval required')
        check(final.get('verified_running_build') is True, 'A0 must inspect the running build')
        identity(final, 'A0 final review')
        evidence(final, 'A0 final review')
    except (OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile) as exc:
        errors.append(f'Malformed manifest or unreadable artifact: {exc}')
    return errors

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--gates', type=Path, help='Default: <root>/contracts/qa-gates.json')
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        gates = json.loads((args.gates or root/'contracts/qa-gates.json').read_text(encoding='utf-8'))
        manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
        errors = validate(manifest, root, gates)
    except (OSError, ValueError) as exc:
        errors = [f'Cannot read gate inputs: {exc}']
    if errors:
        print('OWNER-READINESS EVIDENCE CHECK: FAIL')
        for message in errors:
            print(f'- {message}')
        return 1
    print('OWNER-READINESS EVIDENCE CHECK: PASS')
    print('This validates declarations, identities and artifact integrity only. '
          'It does not execute game tests, prove authentic reports, guarantee zero bugs, '
          'replace human acceptance or authorize publication.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
