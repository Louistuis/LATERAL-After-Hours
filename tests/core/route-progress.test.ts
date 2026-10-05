import {describe,it,expect} from 'vitest';
import {RouteProgressTracker} from '../../src/core/route-progress';
describe('route progress corridor',()=>{
  const route=()=>new RouteProgressTracker([{x:0,y:0,z:0},{x:0,y:0,z:-100},{x:10,y:0,z:-100},{x:10,y:0,z:0}],8);
  it('tracks forward travel but reversing cannot earn new progress',()=>{const t=route();t.update({x:0,y:0,z:0});for(let i=1;i<=50;i++)t.update({x:0,y:0,z:-i});expect(t.update({x:0,y:0,z:-49}).progressM).toBe(50);});
  it('rejects shortcuts to an adjacent later section',()=>{const t=route();t.update({x:0,y:0,z:0});expect(t.update({x:10,y:0,z:0}).legal).toBe(false);expect(t.update({x:10,y:0,z:0}).progressM).toBe(0);});
  it('rejects teleporting and off-road travel',()=>{const t=route();t.update({x:0,y:0,z:0});expect(t.update({x:0,y:0,z:-90}).legal).toBe(false);expect(t.update({x:40,y:0,z:-90}).legal).toBe(false);});
  it('rejects invalid authored data and ignores corrupt runtime positions',()=>{
    expect(()=>new RouteProgressTracker([{x:0,y:0,z:0},{x:0,y:0,z:0}],8)).toThrow('nonzero');
    expect(()=>new RouteProgressTracker([{x:0,y:0,z:0},{x:0,y:0,z:-1}],Infinity)).toThrow('finite');
    expect(()=>new RouteProgressTracker([{x:NaN,y:0,z:0},{x:0,y:0,z:-1}],8)).toThrow('finite');
    const t=route();t.update({x:0,y:0,z:0});
    expect(t.update({x:NaN,y:0,z:0}).legal).toBe(false);
    expect(t.update({x:0,y:0,z:-1})).toMatchObject({legal:true,progressM:1});
  });
  it('allows a brief runoff to rejoin without awarding a shortcut',()=>{
    const t=route();t.update({x:0,y:0,z:0});
    for(let i=1;i<=15;i++)t.update({x:Math.min(i,7),y:0,z:-i});
    for(let i=16;i<=22;i++)expect(t.update({x:22-i,y:0,z:-i}).violation).toBeNull();
    const rejoined=t.update({x:0,y:0,z:-23});
    expect(rejoined).toMatchObject({legal:true,violation:null});
    expect(rejoined.progressM).toBeLessThanOrEqual(23);
    expect(rejoined.progressM).toBeGreaterThan(15);
  });
  it('marks sustained runoff and material reverse travel while allowing a small correction',()=>{
    const t=route();t.update({x:0,y:0,z:0});
    for(let i=1;i<=20;i++)t.update({x:0,y:0,z:-i});
    expect(t.update({x:0,y:0,z:-19}).violation).toBeNull();
    for(let i=18;i>=10;i--)t.update({x:0,y:0,z:-i});
    expect(t.update({x:0,y:0,z:-10}).violation).toBe('wrong-way');
    t.reset();t.update({x:0,y:0,z:0});
    // Runoff that keeps moving (6 m/s alongside the route); a car parked out there is left to the stuck recovery.
    for(let i=0;i<125;i++)t.update({x:7,y:0,z:-i*.1});
    expect(t.update({x:7,y:0,z:-12.5}).violation).toBe('shortcut');
  });
  it('follows an authored tight hairpin without jumping to the parallel return leg',()=>{
    const points=[{x:0,y:0,z:0},{x:0,y:0,z:-20},{x:1,y:0,z:-22},{x:3,y:0,z:-23},{x:5,y:0,z:-22},{x:6,y:0,z:-20},{x:6,y:0,z:0}];
    const t=new RouteProgressTracker(points,4);t.update(points[0]);
    let last=points[0];
    for(const next of points.slice(1)){
      const steps=Math.ceil(Math.hypot(next.x-last.x,next.z-last.z));
      for(let i=1;i<=steps;i++)expect(t.update({x:last.x+(next.x-last.x)*i/steps,y:0,z:last.z+(next.z-last.z)*i/steps}).violation).toBeNull();
      last=next;
    }
    expect(t.update(points.at(-1)!).progressM).toBeCloseTo(t.lengthM);
  });
  it('does not turn a continuous inside-corner crossing into a score-breaking progress jump',()=>{
    const t=new RouteProgressTracker([{x:0,y:0,z:0},{x:0,y:0,z:-10},{x:10,y:0,z:-10}],8);
    t.update({x:0,y:0,z:0});
    for(let i=1;i<=95;i++)t.update({x:.4*i/95,y:0,z:-i/10});
    const before=t.update({x:.4,y:0,z:-9.5});
    const after=t.update({x:.5,y:0,z:-9.6});
    expect(after).toMatchObject({legal:true,segment:1,violation:null});
    expect(after.progressM-before.progressM).toBeLessThan(.25);
    // Forward projection catches up with physical travel; no permanent stall.
    let last=after;
    for(let i=1;i<=50;i++)last=t.update({x:.5+i*.1,y:0,z:-9.6});
    expect(last.progressM).toBeCloseTo(15.5);
  });
  it('reports signed offset from the same plausible segment used for progress',()=>{
    const t=route();t.update({x:0,y:0,z:0});
    expect(t.update({x:2,y:0,z:-1}).lateralOffsetM).toBeCloseTo(2);
    expect(t.update({x:-2,y:0,z:-2}).lateralOffsetM).toBeCloseTo(-2);
    // A geometrically closer later parallel section is not an eligible clip line.
    expect(t.update({x:10,y:0,z:0})).toMatchObject({legal:false,lateralOffsetM:10,segment:0});
    expect(t.update({x:0,y:0,z:-90}).lateralOffsetM).toBeNull();
    expect(t.update({x:NaN,y:0,z:0}).lateralOffsetM).toBeNull();
  });
});
