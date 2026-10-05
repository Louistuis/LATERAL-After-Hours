import { describe, expect, it } from 'vitest';
import { describeBootFailure } from '../../src/core/boot-failure';
import { parseSaveEnvelope, SaveValidationError } from '../../src/save/envelope';

describe('safe boot failure messages',()=>{
  it('identifies an actual future save and gives a non-destructive next step',()=>{
    let failure:unknown;
    try {parseSaveEnvelope('{"schemaVersion":99}');}catch(error){failure=error;}
    const copy=describeBootFailure(failure);
    expect(copy.title).toContain('newer game version');
    expect(copy.message).toContain('stored progress has been kept');
    expect(copy.message).not.toMatch(/connection|delete|reset/i);
  });
  it('does not echo raw storage data or opaque external error messages',()=>{
    const privateDetail='secret account key from an external error';
    expect(JSON.stringify(describeBootFailure(new SaveValidationError('corrupt',privateDetail)))).not.toContain(privateDetail);
    expect(JSON.stringify(describeBootFailure(new Error(privateDetail)))).not.toContain(privateDetail);
    expect(describeBootFailure(new Error('WebGL unavailable')).message).toContain('hardware acceleration');
  });
});
