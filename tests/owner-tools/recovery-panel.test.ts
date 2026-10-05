import { describe, expect, it } from 'vitest';
import type { RecoveryInspection } from '../../src/save/profile-repository';
import { renderRecoveryMarkup } from '../../src/owner-tools';

describe('owner sandbox recovery panel', () => {
  it.each(['corrupt', 'future-version'] as const)('offers backup and explicit session play for %s saves without exposing stored bytes', code => {
    const inspection: RecoveryInspection = {
      status: 'recovery-required', code, message: 'The stored save needs recovery.', rawBytes: 4096,
    };
    const markup = renderRecoveryMarkup(inspection, false, false);
    expect(markup).toContain('data-recovery-status="recovery-required"');
    expect(markup).toContain('Reason code:');
    expect(markup).toContain(code);
    expect(markup).toContain('data-action="export-sandbox-backup"');
    expect(markup).toContain('data-action="play-sandbox-session"');
    expect(markup).toContain('does not overwrite the stored save');
    expect(markup).not.toContain('4096');
    expect(markup).not.toContain('rawBytes');
  });

  it('shows no recovery actions for a clean sandbox', () => {
    const inspection: RecoveryInspection = { status: 'clean', code: null, message: null, rawBytes: null };
    const markup = renderRecoveryMarkup(inspection, false, false);
    expect(markup).toContain('data-recovery-status="clean"');
    expect(markup).not.toContain('data-action=');
  });

  it('shows only a safe availability message when storage cannot be inspected', () => {
    const inspection: RecoveryInspection = { status: 'unavailable', code: null, message: 'Save storage is unavailable.', rawBytes: null };
    const markup = renderRecoveryMarkup(inspection, false, false);
    expect(markup).toContain('Save storage is unavailable.');
    expect(markup).not.toContain('data-action=');
  });

  it('does not render actions for callbacks that the host did not provide', () => {
    const inspection: RecoveryInspection = { status: 'recovery-required', code: 'corrupt', message: 'Damaged save.', rawBytes: 64 };
    const markup = renderRecoveryMarkup(inspection, false, false, false, false);
    expect(markup).not.toContain('data-action=');
  });

  it('reports temporary play without offering a second play action and disables actions while busy', () => {
    const inspection: RecoveryInspection = { status: 'recovery-required', code: 'future-version', message: 'Future format.', rawBytes: 48 };
    const active = renderRecoveryMarkup(inspection, true, false);
    expect(active).toContain('active for this session');
    expect(active).not.toContain('data-action="play-sandbox-session"');
    expect(active).toContain('data-action="export-sandbox-backup"');
    const busy = renderRecoveryMarkup(inspection, false, true);
    expect(busy).toMatch(/data-action="export-sandbox-backup" disabled/);
    expect(busy).toMatch(/data-action="play-sandbox-session" disabled/);
  });

  it('escapes recovery messages and omits raw byte counts from owner markup', () => {
    const inspection: RecoveryInspection = { status: 'recovery-required', code: 'corrupt', message: '<private path>', rawBytes: 8192 };
    const markup = renderRecoveryMarkup(inspection, false, false);
    expect(markup).toContain('&lt;private path&gt;');
    expect(markup).not.toContain('<private path>');
    expect(markup).not.toContain('8192');
  });
});
