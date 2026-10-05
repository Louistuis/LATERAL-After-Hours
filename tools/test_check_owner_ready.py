#!/usr/bin/env python3
"""Synthetic checker tests only. Fixtures are NOT game evidence or game results."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from check_owner_ready import validate
ROOT = Path(__file__).resolve().parents[1]

class OwnerEvidenceCheckerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.gates = json.loads((ROOT/'contracts/qa-gates.json').read_text())
        self.identity = {'build_id':'SYNTHETIC-CHECKER-FIXTURE','commit':'test-fixture-not-game-commit'}
        with zipfile.ZipFile(self.root/'candidate.zip','w') as z:
            z.writestr('dist/owner-review/index.html','Synthetic checker fixture. NOT A GAME.')
        candidate = self.ref('candidate.zip')
        for name in ['requirements.txt','run-1.txt','run-2.txt','S1.txt','S2.txt','S3.txt','A0.txt']:
            (self.root/name).write_text('SYNTHETIC CHECKER UNIT TEST FIXTURE ONLY: '+name)
        self.manifest = {
          'schema_version':1,'status':'PASS',
          'candidate':dict(self.identity,version='fixture',content_hash='a'*64,target='owner-review',artifact=candidate),
          'requirements':[dict(self.identity,id=rid,status='PASS',author='L1',reviewer='S1',evidence=[self.ref('requirements.txt')]) for rid in self.gates['owner_review']['required_acceptance_ids']],
          'clean_regression_runs':[dict(self.identity,id=f'run-{i}',status='PASS',mandatory_failed=0,mandatory_skipped=0,fresh_profile=True,candidate_sha256=candidate['sha256'],author='L6',reviewer='S3',real_input_driven=True,environment={'browser':'synthetic','browser_version':'fixture','os':'fixture','hardware':'fixture','graphics_backend':'fixture','kind':'real-browser'},evidence=[self.ref(f'run-{i}.txt')]) for i in [1,2]],
          'independent_reviews':[dict(self.identity,department_id=sid,status='PASS',author=sid,reviewer='A0',evidence=[self.ref(sid+'.txt')]) for sid in ['S1','S2','S3']],
          'open_defects':[],
          'astra_review':dict(self.identity,agent_id='A0',status='PASS',verified_running_build=True,evidence=[self.ref('A0.txt')])
        }
    def tearDown(self):self.temp.cleanup()
    def ref(self,name):return {'path':name,'sha256':hashlib.sha256((self.root/name).read_bytes()).hexdigest()}
    def errors(self):return validate(self.manifest,self.root,self.gates)
    def rejects(self,needle):self.assertTrue(any(needle in e for e in self.errors()),self.errors())
    def test_synthetic_complete_manifest_passes_integrity_only(self):self.assertEqual(self.errors(),[])
    def test_empty_template_cannot_claim_game_pass(self):
        self.manifest=json.loads((ROOT/'templates/QA_RESULT_MANIFEST.json').read_text());self.assertTrue(self.errors())
    def test_missing_requirement_rejected(self):self.manifest['requirements'].pop();self.rejects('Missing required results')
    def test_unexecuted_requirement_rejected(self):self.manifest['requirements'][0]['status']='UNTESTED';self.rejects('not PASS')
    def test_self_review_rejected(self):self.manifest['requirements'][0]['reviewer']='L1';self.rejects('self-review')
    def test_stale_commit_rejected(self):self.manifest['requirements'][0]['commit']='old';self.rejects('commit mismatch')
    def test_missing_evidence_rejected(self):self.manifest['requirements'][0]['evidence']=[];self.rejects('evidence list')
    def test_hash_tampering_rejected(self):(self.root/'requirements.txt').write_text('changed');self.rejects('SHA-256 mismatch')
    def test_path_traversal_rejected(self):self.manifest['requirements'][0]['evidence'][0]['path']='../secret';self.rejects('inside root')
    def test_one_clean_run_rejected(self):self.manifest['clean_regression_runs'].pop();self.rejects('Two clean')
    def test_reused_run_evidence_rejected(self):self.manifest['clean_regression_runs'][1]['evidence']=self.manifest['clean_regression_runs'][0]['evidence'];self.rejects('reused regression')
    def test_skipped_mandatory_case_rejected(self):self.manifest['clean_regression_runs'][0]['mandatory_skipped']=1;self.rejects('failed or skipped')
    def test_old_candidate_run_rejected(self):self.manifest['clean_regression_runs'][0]['candidate_sha256']='b'*64;self.rejects('candidate artifact mismatch')
    def test_real_input_requirement(self):
        for r in self.manifest['clean_regression_runs']:r['real_input_driven']=False
        self.rejects('real-browser, input-driven')
    def test_open_p2_rejected(self):self.manifest['open_defects']=[{'id':'fixture','severity':'P2','summary':'synthetic issue'}];self.rejects('Open P2')
    def test_open_p1_rejected(self):self.manifest['open_defects']=[{'id':'fixture','severity':'P1','summary':'synthetic issue'}];self.rejects('Open P1')
    def test_missing_department_rejected(self):self.manifest['independent_reviews'].pop();self.rejects('S1/S2/S3')
    def test_uninspected_candidate_rejected(self):self.manifest['astra_review']['verified_running_build']=False;self.rejects('inspect the running')
    def test_wrong_boss_rejected(self):self.manifest['astra_review']['agent_id']='S1';self.rejects('Final A0')
    def test_wrong_target_rejected(self):self.manifest['candidate']['target']='poki';self.rejects('owner-review')
    def test_non_zip_candidate_rejected(self):
        (self.root/'candidate.zip').write_text('not a zip');self.manifest['candidate']['artifact']=self.ref('candidate.zip');self.rejects('prebuilt playable ZIP')

if __name__=='__main__':unittest.main(verbosity=2)
