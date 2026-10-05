import * as THREE from 'three';
import { createVehicleSimulation } from '../physics/index';
import { DrivingSession } from '../driving/session';
import type { InputFrame, VehicleSnapshot } from '../../contracts/runtime-contracts';
import { FrameMetrics } from './metrics';

/** G1 harness. Replaced by the scene and experience compositions at G2. */
export async function startDrivingProof(root: HTMLElement): Promise<void> {
  document.body.style.cssText='margin:0;background:#101719;color:#f2eadc;font-family:Arial,sans-serif;overflow:hidden';
  root.innerHTML='<canvas id="drive" tabindex="0" aria-label="Driving scene"></canvas><div style="position:absolute;top:30px;left:32px;pointer-events:none"><span style="color:#d8fa72;font-size:12px;letter-spacing:4px">STUDIO DEVELOPMENT • G1</span><h1 style="font-size:34px;font-style:italic;margin:8px 0">LATERAL / AFTER HOURS</h1><p>Driving systems proof · not an owner-ready build</p></div><div id="telemetry" style="position:absolute;bottom:35px;left:32px;white-space:pre-line;pointer-events:none;font:14px monospace"></div><div style="position:absolute;bottom:35px;right:32px;pointer-events:none;line-height:1.8">W S · THROTTLE / BRAKE<br>A D · STEER &nbsp; SPACE · HANDBRAKE<br>R · RECOVER &nbsp; ESC · PAUSE<br>Q / E · SHIFT (Q IN FIRST = REVERSE)</div>';
  const canvas=root.querySelector<HTMLCanvasElement>('#drive')!;
  const context=canvas.getContext('webgl2',{antialias:true,alpha:false});
  if(!context) throw new Error('WebGL2 is required. Try a browser with hardware acceleration enabled.');
  const renderer=new THREE.WebGLRenderer({canvas,context,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  const scene=new THREE.Scene();scene.background=new THREE.Color('#b9cad0');scene.fog=new THREE.Fog('#b9cad0',160,700);
  scene.add(new THREE.HemisphereLight('#ecf8ff','#6d6b4a',2));
  const sun=new THREE.DirectionalLight('#ffe0ae',3);sun.position.set(-30,70,-50);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-60;sun.shadow.camera.right=60;sun.shadow.camera.top=60;sun.shadow.camera.bottom=-60;sun.shadow.normalBias=.04;scene.add(sun,sun.target);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(1400,1400),new THREE.MeshStandardMaterial({color:'#72716c',roughness:.93}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
  const lines=new THREE.Group();scene.add(lines);
  for(const radius of [20,40,60]){const ring=new THREE.Mesh(new THREE.RingGeometry(radius-.15,radius+.15,160),new THREE.MeshBasicMaterial({color:'#d0cdc0',side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.012;lines.add(ring);}
  const car=new THREE.Group();scene.add(car);
  const body=new THREE.Mesh(new THREE.BoxGeometry(1.75,.55,4.1),new THREE.MeshPhysicalMaterial({color:'#b4db48',metalness:.55,roughness:.29,clearcoat:1}));body.castShadow=true;car.add(body);
  const roof=new THREE.Mesh(new THREE.BoxGeometry(1.5,.52,1.9),new THREE.MeshStandardMaterial({color:'#162730',metalness:.5,roughness:.2}));roof.position.set(0,.5,.2);roof.castShadow=true;car.add(roof);
  const wheelMat=new THREE.MeshStandardMaterial({color:'#14191a',roughness:.85});
  const wheels=Array.from({length:4},()=>{const mesh=new THREE.Mesh(new THREE.CylinderGeometry(.33,.33,.22,16),wheelMat);mesh.geometry.rotateZ(Math.PI/2);mesh.castShadow=true;scene.add(mesh);return mesh;});
  for(const side of [-1,1]){const lamp=new THREE.Mesh(new THREE.BoxGeometry(.46,.1,.025),new THREE.MeshBasicMaterial({color:'#ff3b21'}));lamp.position.set(side*.55,.05,2.07);car.add(lamp);}
  const sim=await createVehicleSimulation();
  for(const x of [-100,100])sim.addColliderBox({center:{x,y:1,z:0},halfExtents:{x:1,y:1,z:100},category:'wall'});
  const session=new DrivingSession({simulation:sim});const metrics=new FrameMetrics();
  const keys=new Set<string>();let reset=false;let shift: -1|0|1=0;
  const clear=()=>{keys.clear();reset=false;shift=0;};
  window.addEventListener('keydown',event=>{if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code))event.preventDefault();if(event.code==='Escape'&&!event.repeat){if(session.pauses.isPaused())session.pauses.remove('manual');else session.pauses.add('manual');clear();}if(event.code==='KeyR'&&!event.repeat)reset=true;if(!event.repeat&&event.code==='KeyQ')shift=-1;if(!event.repeat&&event.code==='KeyE')shift=1;keys.add(event.code);});
  window.addEventListener('keyup',event=>keys.delete(event.code));window.addEventListener('blur',clear);
  document.addEventListener('visibilitychange',()=>{clear();if(document.hidden)session.pauses.add('hidden');else session.pauses.remove('hidden');});
  const readInput=(simulationTick:number):InputFrame=>{const frame={simulationTick,throttle:Number(keys.has('KeyW')||keys.has('ArrowUp')),brake:Number(keys.has('KeyS')||keys.has('ArrowDown')),steering:Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft')),handbrake:Number(keys.has('Space')),shift,resetPressed:reset};reset=false;shift=0;return frame;};
  const camera=new THREE.PerspectiveCamera(52,1,.1,1400);camera.position.set(0,5,11);
  const resize=()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();};window.addEventListener('resize',resize);resize();canvas.focus();
  const desired=new THREE.Vector3(),forward=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),q=new THREE.Quaternion();
  const hud=root.querySelector<HTMLElement>('#telemetry')!;let last=performance.now(),count=0;
  if(__OWNER_REVIEW__)Object.defineProperty(window,'__LATERAL_PROOF__',{configurable:true,get:()=>({vehicle:sim.snapshot(),paused:session.pauses.isPaused(),metrics:metrics.summary(),tick:session.clock.tick})});
  function draw(snapshot:VehicleSnapshot,dt:number){
    car.position.copy(snapshot.position);car.quaternion.copy(snapshot.rotation);q.copy(snapshot.rotation);forward.set(0,0,-1).applyQuaternion(q);forward.y=0;forward.normalize();
    desired.copy(car.position).addScaledVector(forward,-8).addScaledVector(up,3.5);camera.position.lerp(desired,1-Math.exp(-dt*5));camera.lookAt(car.position.clone().addScaledVector(forward,4).addScaledVector(up,.7));
    snapshot.wheels.forEach((wheel,i)=>{wheels[i]!.position.copy(wheel.position);wheels[i]!.quaternion.copy(wheel.rotation);});sun.position.copy(car.position).add(new THREE.Vector3(-30,70,-50));sun.target.position.copy(car.position);
    renderer.render(scene,camera);
  }
  function frame(now:number){const dt=Math.max(0,(now-last)/1000);last=now;const snapshot=session.advance(dt,readInput).current;metrics.record(dt*1000);draw(snapshot,Math.min(dt,.05));
    if(count++%8===0){const speed=Math.hypot(snapshot.linearVelocityMS.x,snapshot.linearVelocityMS.z)*3.6;hud.textContent=`${speed.toFixed(0)} KM/H   •   GEAR ${snapshot.gear}\n${snapshot.engineRpm.toFixed(0)} RPM   •   ${(snapshot.driftAngleRad*180/Math.PI).toFixed(0)}° SLIP\n${snapshot.wheels.filter(w=>w.contact).length}/4 CONTACTS   •   ${session.pauses.isPaused()?'PAUSED':'DRIVE'}`;}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
