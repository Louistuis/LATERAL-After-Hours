#!/usr/bin/env python3
"""Validate this specification pack, not the implementation or a platform approval.

Standard library only. Run from any directory; optional --root checks a copied pack.
Exit 0: checks passed. Exit 1: structural error. This does not execute game tests.
"""
from __future__ import annotations
import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import re
import sys
from typing import Any

REQUIRED = [
    'START_HERE.md', 'goal.md', 'MASTER_PROMPT.md', 'AGENTS.md',
    'ACCEPTANCE_CRITERIA.md', 'DELIVERABLES.md', 'HANDOFF_COMPLETE.md',
    'production/ROADMAP.md', 'production/RISKS.md', 'production/DECISIONS.md',
    'production/STATUS.md', 'production/SOURCES.md', 'production/agent_roster.json',
    'production/run_state.json', 'production/backlog.json', 'production/backlog.csv',
    'production/acceptance_matrix.csv', 'production/deliverable_tracker.csv',
    'contracts/runtime-contracts.ts', 'contracts/vehicle-config.schema.json',
    'contracts/vehicle-config.example.json', 'contracts/quality-budgets.json',
    'templates/TASK_REPORT.md', 'templates/EVIDENCE_REPORT.md',
    'templates/ASSET_LEDGER.csv', 'templates/BENCHMARK_RESULT.json',
    'templates/RELEASE_REVIEW.md', 'templates/BROWSER_DEVICE_MATRIX.csv',
    'templates/VISUAL_REVIEW.md', 'CHAIN_OF_COMMAND.md', 'OWNER_TESTING.md',
    'COPY_PASTE_PROMPT.txt', 'CHANGELOG.md', 'specs/13_OWNER_REVIEW.md',
    'specs/14_PRE_OWNER_QA.md', 'contracts/owner-review-contracts.ts',
    'contracts/qa-gates.json', 'templates/QA_RESULT_MANIFEST.json',
    'templates/OWNER_HANDOVER.md', 'templates/OWNER_APPROVAL.json',
    'templates/OWNER_FEEDBACK.json', 'templates/BUG_REGISTER.csv',
    'production/authority_log.json', 'tools/check_owner_ready.py',
    'tools/preview_build.mjs',
]

def validate(root: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    notes: list[str] = []
    def check(ok: bool, message: str) -> None:
        if not ok:
            errors.append(message)
    def load_json(name: str) -> Any:
        return json.loads((root / name).read_text(encoding='utf-8'))
    def load_csv(name: str) -> list[dict[str, str]]:
        with (root / name).open(newline='', encoding='utf-8') as file:
            return list(csv.DictReader(file))
    for name in REQUIRED:
        check((root / name).is_file(), f'Missing required file: {name}')
    if errors:
        return errors, notes
    try:
        for path in root.rglob('*.json'):
            json.loads(path.read_text(encoding='utf-8'))
        for path in root.rglob('*.csv'):
            with path.open(newline='', encoding='utf-8') as file:
                rows = list(csv.reader(file))
            check(bool(rows), f'Empty CSV: {path.relative_to(root)}')
            if rows:
                check(all(len(row) == len(rows[0]) for row in rows),
                      f'Unequal CSV column counts: {path.relative_to(root)}')
        roster = load_json('production/agent_roster.json')
        agents = roster['agents']
        rolemap = {agent['id']: agent for agent in agents}
        check(len(agents) == len(rolemap) == 10, 'Expected exactly 10 unique agent slots')
        counts = Counter(agent['requested_model'] for agent in agents)
        check(counts == {'GPT 6 Astra': 1, 'GPT 6 Sol': 3, 'GPT 6 Luna': 6},
              f'Wrong requested model distribution: {dict(counts)}')
        check(roster['root'] == 'A0', 'Root must be A0')
        check(roster['total_slots'] == 10, 'Declared slot count must be 10')
        check(not roster['silent_model_substitution_allowed'], 'Silent substitution must remain forbidden')
        roots = [a for a in agents if a['reports_to'] is None]
        check(len(roots) == 1 and roots[0]['id'] == 'A0', 'Exactly one root A0 required')
        expected = {'A0': ['S1', 'S2', 'S3'], 'S1': ['L1', 'L2'],
                    'S2': ['L3', 'L4'], 'S3': ['L5', 'L6']}
        for aid, agent in rolemap.items():
            check((root / agent['prompt']).is_file(), f'Missing role prompt: {aid}')
            check(agent['direct_reports'] == expected.get(aid, []), f'Wrong reporting children: {aid}')
            parent = agent['reports_to']
            if parent is not None:
                check(parent in rolemap, f'Unknown parent: {aid} -> {parent}')
                if parent in rolemap:
                    check(aid in rolemap[parent]['direct_reports'], f'Nonreciprocal reporting: {aid}')
            check(bool(agent['default_allowed_paths']), f'No ownership paths: {aid}')
        check(set(rolemap['A0']['authority_over']) == set(rolemap) - {'A0'},
              'Astra must have authority over every Sol and Luna')
        for sid in ['S1', 'S2', 'S3']:
            agent = rolemap[sid]
            check(agent.get('hands_on_implementation_required') is True,
                  f'Sol must remain hands-on: {sid}')
            check(set(agent['authority_over']) == set(expected[sid]),
                  f'Sol authority must cover its two Luna workers: {sid}')
            check(any(p.startswith('src/') for p in agent['default_allowed_paths']),
                  f'Sol needs production implementation paths: {sid}')
        for aid, agent in rolemap.items():
            check(agent.get('ultimate_agent_authority') == 'A0', f'Wrong ultimate authority: {aid}')
        check(roster['authority_policy']['astra_direct_luna_instruction_allowed'] is True,
              'Astra direct Luna intervention must remain allowed')
        check(roster['authority_policy']['notify_luna_supervisor_on_direct_instruction'] is True,
              'Direct intervention must notify the Sol supervisor')
        notes.append('10 slots: Astra authority over all nine subordinates; three hands-on Sol leads each supervise two Lunas.')
        requirements = load_csv('production/acceptance_matrix.csv')
        req_ids = {r['requirement_id'] for r in requirements}
        check(len(requirements) == len(req_ids), 'Duplicate acceptance requirement IDs')
        allowed_status = {'NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'IN_PROGRESS', 'UNTESTED'}
        for row in requirements:
            rid = row['requirement_id']
            check(row['accountable'] in rolemap, f'Unknown acceptance owner: {rid}')
            check(row['status'] in allowed_status, f'Invalid acceptance status: {rid}')
            if row['status'] == 'PASS':
                check(bool(row['evidence_path'] and row['reviewer'] and row['commit']),
                      f'PASS lacks evidence/reviewer/commit: {rid}')
        board = load_json('production/backlog.json')
        tasks = board['tasks']
        taskmap = {t['id']: t for t in tasks}
        check(len(tasks) == len(taskmap), 'Duplicate task IDs')
        check(len(tasks) >= 68, 'Expected at least the 68 handoff tasks')
        referenced: set[str] = set()
        for task in tasks:
            tid = task['id']
            check(task['owner'] in rolemap, f'Unknown task owner: {tid}')
            check(task['reviewer'] in rolemap, f'Unknown task reviewer: {tid}')
            check(task['reviewer'] != task['owner'], f'Self-review is not allowed: {tid}')
            check(task['status'] in {'TODO','READY','IN_PROGRESS','BLOCKED','IN_REVIEW','DONE'},
                  f'Invalid task status: {tid}')
            check(bool(task['acceptance_ids']), f'Task has no acceptance links: {tid}')
            for rid in task['acceptance_ids']:
                check(rid in req_ids, f'Unknown acceptance requirement {rid} in {tid}')
                referenced.add(rid)
            for dep in task['depends_on']:
                check(dep in taskmap and dep != tid, f'Invalid dependency: {tid} -> {dep}')
            if task['status'] == 'DONE':
                check(bool(task['actual_evidence']), f'DONE lacks evidence: {tid}')
        check(req_ids <= referenced, f'Acceptance rows not covered by tasks: {sorted(req_ids-referenced)}')
        active: set[str] = set()
        visited: set[str] = set()
        def visit(tid: str) -> None:
            if tid in active:
                errors.append(f'Task graph contains a cycle at {tid}')
                return
            if tid in visited or tid not in taskmap:
                return
            active.add(tid)
            for dep in taskmap[tid]['depends_on']:
                visit(dep)
            active.remove(tid)
            visited.add(tid)
        for tid in taskmap:
            visit(tid)
        export = load_csv('production/backlog.csv')
        exportmap = {t['id']: t for t in export}
        check(set(exportmap) == set(taskmap), 'CSV/JSON backlog IDs differ')
        for tid, task in taskmap.items():
            if tid in exportmap:
                for field in ['gate','owner','reviewer','title','status','evidence_path']:
                    check(str(task[field]) == exportmap[tid][field], f'CSV/JSON mismatch: {tid}.{field}')
                for field in ['depends_on', 'acceptance_ids']:
                    check(';'.join(task[field]) == exportmap[tid][field], f'CSV/JSON mismatch: {tid}.{field}')
        for tid, sid in [('T069','S1'), ('T070','S2'), ('T071','S3')]:
            check(taskmap.get(tid, {}).get('owner') == sid,
                  f'Missing Sol production implementation task: {sid}')
        notes.append(f'{len(tasks)} tasks with valid owners, independent reviewers and an acyclic dependency graph.')
        deliverables = load_csv('production/deliverable_tracker.csv')
        check(len(deliverables) == len({d['deliverable_id'] for d in deliverables}), 'Duplicate deliverable IDs')
        covered: set[str] = set()
        for row in deliverables:
            check(row['owner'] in rolemap, f'Unknown deliverable owner: {row["deliverable_id"]}')
            for rid in row['acceptance_ids'].split(';'):
                check(rid in req_ids, f'Unknown deliverable requirement: {rid}')
                covered.add(rid)
        check(req_ids <= covered, f'Acceptance rows not covered by deliverables: {sorted(req_ids-covered)}')
        notes.append(f'{len(requirements)} acceptance requirements and {len(deliverables)} deliverable groups cross-referenced.')
        gates = load_json('contracts/qa-gates.json')
        internal = set(gates['owner_review']['required_acceptance_ids'])
        later = set(gates['later_external_ids'])
        check(internal.isdisjoint(later), 'Internal and later external gate IDs must not overlap')
        check(internal | later == req_ids, 'Every acceptance ID must have an explicit gate stage')
        check({'BRW-01','PER-01','PER-02','PER-03','OWN-01','OWN-06','QA-01','QA-02','QA-03','QA-04'} <= internal,
              'Required internal browser/performance/owner/QA checks cannot be removed')
        check(gates['owner_review']['candidate_target'] == 'owner-review', 'Private owner target required')
        check(gates['owner_review']['clean_core_regression_runs_min'] >= 2, 'Two clean regressions required')
        check(gates['owner_review']['open_defects_max'] == {'P0':0,'P1':0,'P2':0},
              'Open P0/P1/P2 defects must block owner readiness')
        for target, por in [('poki','POR-01'), ('crazygames-basic','POR-02'), ('crazygames-full','POR-03')]:
            stage = gates['submission_ready'][target]
            check(stage['requires_owner_ready'] is True, f'Owner-ready gate missing for {target}')
            check({'REL-05', por} <= set(stage['additional_acceptance_ids']),
                  f'Owner approval or actual preview missing for {target}')
        notes.append(f'{len(internal)} mandatory pre-owner checks; later human/portal decisions remain explicit and target-specific.')
        source_text = (root / 'production/SOURCES.md').read_text(encoding='utf-8')
        defined = set(re.findall(r'^## (S\d{2})\b', source_text, flags=re.M))
        for path in root.rglob('*.md'):
            text = path.read_text(encoding='utf-8')
            for bracket in re.findall(r'\[(S\d{2}(?:\s*,\s*S\d{2})*)\]', text):
                for source in re.findall(r'S\d{2}', bracket):
                    check(source in defined, f'Undefined source {source}: {path.relative_to(root)}')
        notes.append(f'{len(defined)} primary sources registered; narrative source labels resolve.')
        budgets = load_json('contracts/quality-budgets.json')
        check(budgets['simulation']['fixed_hz'] == 60, 'Fixed simulation contract must be 60 Hz')
        check(budgets['storage']['save_utf8_bytes_max'] == 524288, 'Save budget must be 512 KiB')
        check(budgets['loading']['initial_playable_transfer_bytes_max'] == 8000000,
              'First-playable internal target must be 8 decimal MB')
        example = load_json('contracts/vehicle-config.example.json')
        schema = load_json('contracts/vehicle-config.schema.json')
        check(set(schema['required']) <= set(example), 'Vehicle example misses required keys')
        curve = example['engine']['torqueCurve']
        rpms = [point['rpm'] for point in curve]
        check(rpms == sorted(set(rpms)), 'Engine torque samples must use strictly increasing RPM')
        notes.append('Shared timing, quality-budget units and vehicle seed structure are consistent.')
        if board.get('implementation_status') == 'NOT_STARTED':
            check(all(t['status'] == 'TODO' and not t['actual_evidence'] for t in tasks),
                  'Initial handoff must not contain completed tasks or fabricated evidence')
            check(all(r['status'] == 'NOT_RUN' for r in requirements),
                  'Initial handoff must not contain asserted game test results')
            check(all(d['status'] == 'NOT_BUILT' for d in deliverables),
                  'Initial handoff must not contain asserted finished game deliverables')
            notes.append('Initial game implementation, game tests and release outputs remain explicitly uncompleted.')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f'Cannot validate malformed or unreadable data: {exc}')
    return errors, notes

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--report', type=Path, help='Write a Markdown structural report to this local path')
    args = parser.parse_args()
    root = args.root.resolve()
    errors, notes = validate(root)
    result = 'PASS' if not errors else 'FAIL'
    lines = ['# Handoff structural validation', '', f'Result: **{result}**', '',
             'Scope: documentation/package integrity only. No game was built, agents launched, '
             'performance tested, rights cleared, or portal release approved by this check.', '',
             '## Checks', '']
    lines.extend(f'- {note}' for note in notes)
    if errors:
        lines.extend(['', '## Errors', ''] + [f'- {error}' for error in errors])
    report = '\n'.join(lines) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, encoding='utf-8')
    print(report)
    return 1 if errors else 0

if __name__ == '__main__':
    sys.exit(main())
