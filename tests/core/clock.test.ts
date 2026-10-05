import { describe, expect, it } from 'vitest';
import { FixedClock, PauseSet } from '../../src/core/clock';
import { FrameMetrics } from '../../src/core/metrics';
describe('authoritative active clock', () => {
  it.each([30,60,120])('advances exactly 3600 ticks over 60 seconds at %s render Hz', hz=>{
    const clock = new FixedClock(); let count=0;
    for(let f=0;f<hz*60;f++) clock.advance(1/hz,false,()=>{count++;});
    expect(count).toBe(3600); expect(clock.droppedSeconds).toBe(0);
  });
  it('bounds catch-up and reports lost time',()=>{
    const clock=new FixedClock(); let count=0; clock.advance(12,false,()=>{count++;});
    expect(count).toBe(5); expect(clock.droppedSeconds).toBeGreaterThan(11.8);
  });
  it('never resumes under another pause owner or catches up hidden time',()=>{
    const pause=new PauseSet(); pause.add('manual'); pause.add('hidden'); pause.remove('hidden');
    expect(pause.isPaused()).toBe(true); const clock=new FixedClock();
    clock.advance(120,true,()=>{throw new Error('paused clock ran');});
    pause.remove('manual'); clock.advance(1/60,pause.isPaused(),()=>{}); expect(clock.tick).toBe(1);
  });
  it('does not count a canceled catch-up step or replay its remaining time after resume',()=>{
    const clock=new FixedClock();let steps=0;
    clock.advance(5/60,false,()=>{if(steps===2)return false;steps++;});
    expect(steps).toBe(2);expect(clock.tick).toBe(2);expect(clock.droppedSeconds).toBe(0);
    clock.advance(1/60,false,()=>{steps++;});
    expect(steps).toBe(3);expect(clock.tick).toBe(3);
  });
});
it('reports actual nearest-rank frame percentiles without inventing GPU data',()=>{
  const metrics=new FrameMetrics(); for(let i=0;i<99;i++)metrics.record(16);metrics.record(110);
  expect(metrics.summary()).toMatchObject({frames:100,p95:16,p99:16,max:110,gpuMs:null});
});
