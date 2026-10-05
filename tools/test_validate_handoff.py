#!/usr/bin/env python3
"""Local self-tests for the handoff validator. No game tests are executed."""
from __future__ import annotations
import csv
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from validate_handoff import validate

ROOT = Path(__file__).resolve().parents[1]

class HandoffValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.copy = Path(self.temp.name) / 'handoff'
        shutil.copytree(ROOT, self.copy, ignore=shutil.ignore_patterns('__pycache__'))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_unmodified_handoff_passes(self) -> None:
        errors, _ = validate(self.copy)
        self.assertEqual(errors, [])

    def test_missing_document_fails(self) -> None:
        (self.copy / 'goal.md').unlink()
        errors, _ = validate(self.copy)
        self.assertTrue(any('Missing required file: goal.md' in e for e in errors))

    def test_wrong_model_distribution_fails(self) -> None:
        path = self.copy / 'production/agent_roster.json'
        data = json.loads(path.read_text(encoding='utf-8'))
        data['agents'][-1]['requested_model'] = 'GPT 6 Sol'
        path.write_text(json.dumps(data), encoding='utf-8')
        errors, _ = validate(self.copy)
        self.assertTrue(any('Wrong requested model distribution' in e for e in errors))

    def test_task_cycle_fails(self) -> None:
        path = self.copy / 'production/backlog.json'
        data = json.loads(path.read_text(encoding='utf-8'))
        data['tasks'][0]['depends_on'] = ['T068']
        path.write_text(json.dumps(data), encoding='utf-8')
        errors, _ = validate(self.copy)
        self.assertTrue(any('cycle' in e for e in errors))

    def test_unsupported_pass_claim_fails(self) -> None:
        path = self.copy / 'production/acceptance_matrix.csv'
        with path.open(newline='', encoding='utf-8') as file:
            reader = csv.DictReader(file)
            fields = reader.fieldnames
            rows = list(reader)
        rows[0]['status'] = 'PASS'
        with path.open('w', newline='', encoding='utf-8') as file:
            writer = csv.DictWriter(file, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        errors, _ = validate(self.copy)
        self.assertTrue(any('PASS lacks evidence' in e for e in errors))

    def test_astra_must_control_luna(self) -> None:
        path = self.copy / 'production/agent_roster.json'
        data = json.loads(path.read_text())
        data['agents'][0]['authority_over'].remove('L6')
        path.write_text(json.dumps(data))
        errors, _ = validate(self.copy)
        self.assertTrue(any('authority over every' in e for e in errors))

    def test_sol_cannot_be_report_only(self) -> None:
        path = self.copy / 'production/agent_roster.json'
        data = json.loads(path.read_text())
        next(a for a in data['agents'] if a['id']=='S1')['hands_on_implementation_required'] = False
        path.write_text(json.dumps(data))
        errors, _ = validate(self.copy)
        self.assertTrue(any('hands-on' in e for e in errors))

    def test_single_regression_threshold_rejected(self) -> None:
        path = self.copy / 'contracts/qa-gates.json'
        data = json.loads(path.read_text())
        data['owner_review']['clean_core_regression_runs_min'] = 1
        path.write_text(json.dumps(data))
        errors, _ = validate(self.copy)
        self.assertTrue(any('Two clean regressions' in e for e in errors))

    def test_internal_device_gate_cannot_be_removed(self) -> None:
        path = self.copy / 'contracts/qa-gates.json'
        data = json.loads(path.read_text())
        data['owner_review']['required_acceptance_ids'].remove('BRW-01')
        path.write_text(json.dumps(data))
        errors, _ = validate(self.copy)
        self.assertTrue(any('cannot be removed' in e for e in errors))

if __name__ == '__main__':
    unittest.main(verbosity=2)
