const categories = ['staticWorld', 'car', 'other'];
const passes = ['main', 'shadow'];

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validatePassCensusRecord(record) {
  const errors = [];
  if (record?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const identity = record?.identity;
  for (const field of ['buildId', 'commit', 'sourceHash', 'contentHash']) {
    if (typeof identity?.[field] !== 'string' || identity[field].length === 0) errors.push(`identity.${field} is required`);
  }
  if (identity?.target !== 'owner-review') errors.push('identity.target must be owner-review');
  if (identity?.workingTreeDirty !== false) errors.push('identity.workingTreeDirty must be false');
  if (!['low', 'balanced', 'high'].includes(record?.quality)) errors.push('quality must be a fixed graphics preset');
  if (record?.contextState !== 'ready') errors.push('contextState must be ready');
  if (record?.paused !== true) errors.push('the census frame must be paused');

  const pose = record?.pose;
  if (pose?.routeId !== 'HW-01') errors.push('pose.routeId must be HW-01');
  if (pose?.routeLegal !== true) errors.push('pose must be inside the legal route corridor');
  if (pose?.roadWheelContactCount !== 4) errors.push('pose must have four road-wheel contacts');
  if (!Number.isFinite(pose?.routeProgressM)) errors.push('pose.routeProgressM is required');
  if (!Number.isFinite(pose?.routeDistanceM) || pose.routeDistanceM < 0) errors.push('pose.routeDistanceM must be nonnegative');
  if (!isCount(pose?.tickBefore) || pose?.tickBefore !== pose?.tickAfter) errors.push('pose tick must remain fixed across census');
  if (pose?.samePoseAfter !== true) errors.push('pose must be unchanged across census');

  const before = record?.snapshotBracket?.beforeCensus;
  const after = record?.snapshotBracket?.afterCensus;
  if (!before || !after) errors.push('snapshotBracket must include beforeCensus and afterCensus');
  if (before?.paused !== true || after?.paused !== true) errors.push('both snapshot bracket frames must be paused');
  if (before?.quality !== record?.quality || after?.quality !== record?.quality) errors.push('snapshot bracket quality must match the fixed preset');
  if (before?.contextState !== 'ready' || after?.contextState !== 'ready') errors.push('snapshot bracket contexts must be ready');
  if (before?.tick !== after?.tick || before?.tick !== pose?.tickBefore) errors.push('snapshot bracket tick must remain fixed');
  if (before?.routeId !== 'HW-01' || before?.routeLegal !== true || before?.roadWheelContactCount !== 4) {
    errors.push('beforeCensus snapshot must be a legal four-contact HW-01 pose');
  }
  if (record?.diagnosticFrame?.tick !== pose?.tickAfter
    || record?.diagnosticFrame?.quality !== record?.quality
    || record?.diagnosticFrame?.contextState !== 'ready') {
    errors.push('diagnosticFrame tick, quality or context does not match the record');
  }

  const census = record?.census;
  for (const pass of passes) {
    for (const category of categories) {
      const bucket = census?.[pass]?.[category];
      if (!isCount(bucket?.submissions)) errors.push(`census.${pass}.${category}.submissions must be a nonnegative integer`);
      if (!isCount(bucket?.instances)) errors.push(`census.${pass}.${category}.instances must be a nonnegative integer`);
    }
  }
  if (!isCount(census?.rendererInfoCalls)) errors.push('census.rendererInfoCalls must be a nonnegative integer');
  const callbackTotal = passes.flatMap(pass => categories.map(category => census?.[pass]?.[category]?.submissions ?? NaN))
    .reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(census?.callbackAggregateDelta)
    || census.callbackAggregateDelta !== callbackTotal - census?.rendererInfoCalls) {
    errors.push('census.callbackAggregateDelta must equal callbacks minus rendererInfoCalls');
  }
  if (record?.diagnosticFrame?.census?.rendererInfoCalls !== census?.rendererInfoCalls) {
    errors.push('diagnosticFrame census must match the recorded aggregate');
  }
  if (record?.diagnosticFrame?.stageCounters?.drawCallsAllPasses !== census?.rendererInfoCalls) {
    errors.push('diagnosticFrame stage all-pass calls must match renderer.info');
  }
  return { valid: errors.length === 0, errors };
}
