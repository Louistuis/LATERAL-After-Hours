#!/usr/bin/env python3
"""Static-server HTTP tests against synthetic files, not game/browser QA."""
from __future__ import annotations
import http.client
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
ROOT=Path(__file__).resolve().parents[1]
NODE=shutil.which('node')

@unittest.skipUnless(NODE,'Node runtime unavailable: server tests not executed')
class PreviewServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.root=Path(cls.temp.name)/'test build with spaces';cls.root.mkdir()
        (cls.root/'index.html').write_text('SYNTHETIC SERVER FIXTURE; NOT A GAME.')
        (cls.root/'engine.wasm').write_bytes(b'0123456789')
        (cls.root/'empty.txt').write_bytes(b'')
        (cls.root/'.secret').write_text('not for serving')
        (cls.root/'folder').mkdir()
        outside=cls.root.parent/'outside.txt';outside.write_text('outside')
        try:(cls.root/'escape.txt').symlink_to(outside);cls.symlink=True
        except OSError:cls.symlink=False
        cls.proc=subprocess.Popen([NODE,str(ROOT/'tools/preview_build.mjs'),'--dir',str(cls.root),'--port','0'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        output=queue.Queue()
        threading.Thread(target=lambda:[output.put(line) for line in cls.proc.stdout],daemon=True).start()
        try:
            line=output.get(timeout=8)
            match=re.search(r'Preview: http://127\.0\.0\.1:(\d+)/',line)
            if not match:raise RuntimeError(line)
            cls.port=int(match.group(1))
        except Exception:
            cls.proc.terminate();cls.proc.wait(timeout=5);cls.temp.cleanup();raise
    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.wait(timeout=5)
        cls.proc.stdout.close();cls.temp.cleanup()
    def request(self,path='/',method='GET',headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=4)
        try:
            c.request(method,path,headers=headers or {});r=c.getresponse();return r.status,dict(r.getheaders()),r.read()
        finally:c.close()
    def test_index_and_spaces_path(self):
        code,_,body=self.request();self.assertEqual(code,200);self.assertIn(b'NOT A GAME',body)
    def test_wasm_mime(self):self.assertEqual(self.request('/engine.wasm')[1]['Content-Type'],'application/wasm')
    def test_missing_asset_not_html_fallback(self):self.assertEqual(self.request('/missing.glb')[0],404)
    def test_hidden_file_forbidden(self):self.assertEqual(self.request('/.secret')[0],403)
    def test_traversal_forbidden(self):self.assertEqual(self.request('/%2e%2e%2foutside.txt')[0],403)
    def test_directory_listing_disabled(self):self.assertEqual(self.request('/folder/')[0],404)
    def test_symlink_escape_forbidden(self):
        if not self.symlink:self.skipTest('symlinks not supported')
        self.assertEqual(self.request('/escape.txt')[0],403)
    def test_byte_range(self):
        code,headers,body=self.request('/engine.wasm',headers={'Range':'bytes=2-4'});self.assertEqual((code,body),(206,b'234'));self.assertEqual(headers['Content-Range'],'bytes 2-4/10')
    def test_invalid_range(self):self.assertEqual(self.request('/engine.wasm',headers={'Range':'bytes=99-100'})[0],416)
    def test_head(self):
        code,headers,body=self.request('/engine.wasm','HEAD');self.assertEqual((code,body),(200,b''));self.assertEqual(headers['Content-Length'],'10')
    def test_write_methods_refused(self):self.assertEqual(self.request('/','POST')[0],405)
    def test_nonlocal_host_header(self):self.assertEqual(self.request('/',headers={'Host':'attacker.example'})[0],403)
    def test_missing_build_fails(self):
        p=subprocess.run([NODE,str(ROOT/'tools/preview_build.mjs'),'--dir',str(self.root/'nonexistent')],capture_output=True,text=True,timeout=5);self.assertNotEqual(p.returncode,0);self.assertIn('No built game',p.stderr)
    def test_empty_asset(self):
        code,_,body=self.request('/empty.txt');self.assertEqual((code,body),(200,b''))

if __name__=='__main__':unittest.main(verbosity=2)
