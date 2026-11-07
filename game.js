(() => {
  'use strict';
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const $ = (id) => document.getElementById(id);
  const startScreen = $('start-screen'), endScreen = $('end-screen');
  const healthBar = $('health-bar'), healthValue = $('health-value');
  const ammoState = $('ammo-state'), ammoHint = $('ammo-hint');
  const keys = new Set(), touch = new Set();
  const mapRows = [
    '################',
    '#..............#',
    '#..##.....##...#',
    '#..##..........#',
    '#..............#',
    '#........##....#',
    '#..#...........#',
    '#..#.....#.....#',
    '#........#.....#',
    '#....##........#',
    '#....##...#....#',
    '#.........#....#',
    '#..............#',
    '#...##.........#',
    '#..............#',
    '################'
  ];
  const map = mapRows.map(row => row.split(''));
  const W = map[0].length, H = map.length, FOV = Math.PI * .37;
  let width = 800, height = 500, pixelRatio = 1, last = 0, playing = false, pointerLocked = false;
  let player, enemies, bullet, wave, kills, flash, damageFlash, recoil, bob, time = 0;
  let soundOn = true, audio;
  const depthBuffer = new Float32Array(1200);
  let alertTimer = 0;

  function resize() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.min(1100, Math.max(480, Math.floor(innerWidth * pixelRatio)));
    height = Math.min(740, Math.max(320, Math.floor(innerHeight * pixelRatio)));
    canvas.width = width; canvas.height = height;
    canvas.style.width = '100%'; canvas.style.height = '100%';
  }
  window.addEventListener('resize', resize); resize();

  function isWall(x, y) {
    const cx = Math.floor(x), cy = Math.floor(y);
    return cx < 0 || cy < 0 || cx >= W || cy >= H || map[cy][cx] === '#';
  }
  function moveEntity(entity, dx, dy, radius = .22) {
    if (!isWall(entity.x + dx + Math.sign(dx) * radius, entity.y) && !isWall(entity.x + dx, entity.y)) entity.x += dx;
    if (!isWall(entity.x, entity.y + dy + Math.sign(dy) * radius) && !isWall(entity.x, entity.y + dy)) entity.y += dy;
  }
  function reset() {
    player = { x: 7.5, y: 13.2, angle: -Math.PI / 2, health: 100, loaded: true, hurtCooldown: 0 };
    wave = 1; kills = 0; flash = 0; damageFlash = 0; recoil = 0; bob = 0;
    bullet = null;
    spawnWave(); updateHud();
  }
  function spawnWave() {
    const candidates = [[2.5,2.5],[7.5,2.5],[13.2,2.5],[4.5,5.5],[11.5,6.5],[2.5,9.5],[12.5,11.5],[8.5,14.4],[5.5,12.5],[13.4,8.5]];
    enemies = [];
    const count = Math.min(3 + wave - 1, 8);
    for (let n = 0; n < count; n++) {
      let p = candidates[(n * 3 + wave - 1) % candidates.length];
      if (Math.hypot(p[0] - player.x, p[1] - player.y) < 4) p = candidates[(n * 3 + 4) % candidates.length];
      enemies.push({ x:p[0], y:p[1], alive:true, attack:1 + Math.random(), phase:Math.random()*6, hit:0 });
    }
    updateHud();
  }
  function updateHud() {
    $('wave-number').textContent = String(wave).padStart(2,'0');
    $('enemy-count').textContent = enemies ? enemies.filter(e=>e.alive).length : 0;
    if (!player) return;
    healthBar.style.width = `${player.health}%`;
    healthValue.textContent = `${Math.ceil(player.health)}%`;
    const loaded = player.loaded;
    ammoState.textContent = loaded ? 'LOADED' : 'ROUND OUT';
    ammoState.classList.toggle('empty', !loaded);
    $('bullet-display').innerHTML = loaded
      ? '<span class="bullet-icon">▰</span><span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span>'
      : '<span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span><span class="bullet-icon dim">▰</span>';
    ammoHint.textContent = loaded ? 'ONE ROUND. MAKE IT COUNT.' : 'GO PICK UP YOUR BULLET.';
    $('objective-text').textContent = enemies && enemies.some(e=>e.alive) ? `CLEAR THE VAULT  //  ${kills} DOWN` : 'VAULT CLEARED';
  }
  function showAlert(message, duration = 1.25) {
    const el = $('alert'); el.textContent = message; el.classList.add('show'); alertTimer = duration;
  }

  function audioContext() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  function tone(freq, duration, type = 'sine', volume = .06, endFreq = null) {
    if (!soundOn) return;
    try {
      const a = audioContext(), osc = a.createOscillator(), gain = a.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, a.currentTime);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, a.currentTime + duration);
      gain.gain.setValueAtTime(volume, a.currentTime); gain.gain.exponentialRampToValueAtTime(.001, a.currentTime + duration);
      osc.connect(gain); gain.connect(a.destination); osc.start(); osc.stop(a.currentTime + duration);
    } catch (_) {}
  }
  function shoot() {
    if (!playing || !player) return;
    if (!player.loaded) { showAlert(bullet ? 'YOUR ROUND IS STILL OUT THERE' : 'NO ROUND — MOVE!', .8); tone(150,.08,'square',.025); return; }
    player.loaded = false; recoil = 1; flash = .17; tone(95,.22,'sawtooth',.16,32);
    let nearestWall = castRay(player.angle).distance;
    let target = null, best = nearestWall + .01;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx=e.x-player.x, dy=e.y-player.y, distance=Math.hypot(dx,dy);
      let diff = Math.atan2(Math.sin(Math.atan2(dy,dx)-player.angle), Math.cos(Math.atan2(dy,dx)-player.angle));
      const aimTolerance = Math.atan2(.34, distance);
      if (Math.abs(diff) < aimTolerance && distance < best) { target=e; best=distance; }
    }
    let bx = player.x + Math.cos(player.angle) * Math.max(.65, Math.min(best - .32, 7.2));
    let by = player.y + Math.sin(player.angle) * Math.max(.65, Math.min(best - .32, 7.2));
    if (target) {
      target.alive = false; target.hit = 1; kills++; bx=target.x; by=target.y;
      showAlert('NICE SHOT // RETRIEVE THE ROUND', 1.8); tone(720,.09,'triangle',.1,310);
      $('enemy-count').textContent = enemies.filter(e=>e.alive).length;
    } else {
      const along=Math.max(.6, Math.min(nearestWall - .42,7.2));
      bx=player.x+Math.cos(player.angle)*along; by=player.y+Math.sin(player.angle)*along;
      showAlert('ROUND SPENT // GO GET IT', 1.3);
    }
    bullet = {x:bx,y:by, pulse:0}; updateHud();
  }
  function castRay(angle) {
    const dx=Math.cos(angle), dy=Math.sin(angle);
    let mx=Math.floor(player.x), my=Math.floor(player.y);
    const deltaX=Math.abs(1/(dx || 1e-9)), deltaY=Math.abs(1/(dy || 1e-9));
    const stepX=dx<0?-1:1, stepY=dy<0?-1:1;
    let sideX=dx<0?(player.x-mx)*deltaX:(mx+1-player.x)*deltaX;
    let sideY=dy<0?(player.y-my)*deltaY:(my+1-player.y)*deltaY;
    let side=0, guard=0;
    while (guard++ < 80) {
      if (sideX < sideY) { sideX+=deltaX; mx+=stepX; side=0; }
      else { sideY+=deltaY; my+=stepY; side=1; }
      if (mx<0||my<0||mx>=W||my>=H||map[my][mx]==='#') break;
    }
    let distance = side===0 ? sideX-deltaX : sideY-deltaY;
    distance=Math.max(.001,distance);
    const hit = side===0 ? player.y+distance*dy : player.x+distance*dx;
    return {distance,side,wall:hit-Math.floor(hit),mx,my};
  }

  function render() {
    const horizon=Math.floor(height*.48), strip=2;
    const sky=ctx.createLinearGradient(0,0,0,horizon);
    sky.addColorStop(0,'#11171d'); sky.addColorStop(.72,'#3b3732'); sky.addColorStop(1,'#75533e');
    ctx.fillStyle=sky;ctx.fillRect(0,0,width,horizon);
    ctx.fillStyle='rgba(228,117,65,.09)';ctx.fillRect(0,horizon-2,width,4);
    const floor=ctx.createLinearGradient(0,horizon,0,height);floor.addColorStop(0,'#35302a');floor.addColorStop(.5,'#201e1b');floor.addColorStop(1,'#111417');ctx.fillStyle=floor;ctx.fillRect(0,horizon,width,height-horizon);
    const rays=Math.ceil(width/strip), stepAngle=FOV/rays;
    for(let i=0;i<rays;i++){
      const screenX=i*strip, rayAngle=player.angle-FOV/2+(i+.5)*stepAngle;
      const hit=castRay(rayAngle), corrected=hit.distance*Math.cos(rayAngle-player.angle);
      depthBuffer[i]=corrected;
      const wallH=Math.min(height*2,height/(corrected*.84));
      const top=horizon-wallH/2;
      let texture=hit.wall;
      const seam=texture<.035||texture>.965;
      const mortar=(Math.floor((top%48+48)%48/12)===0);
      let shade=Math.max(.18,1-corrected/12)*(hit.side===1?.7:1);
      const brick=(Math.floor(texture*8)%2===0 ? .98 : .82);
      let color=seam?'#2a2926':mortar?'#3e3932':(brick>.9?'#765646':'#604638');
      if(hit.my===1||hit.my===14) color=seam?'#282a29':mortar?'#49443a':(brick>.9?'#877457':'#716449');
      const tint=Math.floor(shade*255);
      ctx.fillStyle=`rgb(${Math.floor((color==='#765646'?118:color==='#604638'?96:color==='#877457'?135:color==='#716449'?113:color==='#49443a'?73:color==='#3e3932'?62:color==='#2a2926'?42:40)*shade)},${Math.floor((color==='#765646'?86:color==='#604638'?66:color==='#877457'?116:color==='#716449'?100:color==='#49443a'?68:color==='#3e3932'?57:color==='#2a2926'?41:41)*shade)},${Math.floor((color==='#765646'?68:color==='#604638'?54:color==='#877457'?87:color==='#716449'?73:color==='#49443a'?58:color==='#3e3932'?50:color==='#2a2926'?38:39)*shade)})`;
      ctx.fillRect(screenX,top,strip+1,wallH);
      // Rust-lit vertical edges and occasional inset wall panels.
      if(seam) {ctx.fillStyle=`rgba(234,127,72,${Math.max(0,.27-corrected*.022)})`;ctx.fillRect(screenX,top,1,wallH);}
      if((Math.floor(hit.wall*6)===2)&&wallH>35) {ctx.fillStyle=`rgba(25,24,22,${.35*shade})`;ctx.fillRect(screenX,top+wallH*.43,strip+1,Math.max(1,wallH*.025));}
      const fog=Math.min(.76,corrected/18);if(fog>.01){ctx.fillStyle=`rgba(14,17,20,${fog})`;ctx.fillRect(screenX,top,strip+1,wallH);}
    }
    drawFloorGrid(horizon);
    drawSprites(horizon,strip,rays);
    drawWeapon();
    if(flash>0){ctx.fillStyle=`rgba(255,157,87,${flash*1.65})`;ctx.fillRect(0,0,width,height);}
    if(damageFlash>0){ctx.fillStyle=`rgba(177,29,25,${damageFlash*.23})`;ctx.fillRect(0,0,width,height);}
    // CRT grain and restrained scanlines.
    ctx.fillStyle='rgba(4,5,7,.10)';for(let y=1;y<height;y+=4)ctx.fillRect(0,y,width,1);
  }
  function drawFloorGrid(horizon) {
    // Perspective tile seams breathe toward the vanishing point.
    ctx.save();ctx.globalAlpha=.13;ctx.strokeStyle='#c0835e';ctx.lineWidth=1;
    const forwardX=Math.cos(player.angle),forwardY=Math.sin(player.angle),rightX=-forwardY,rightY=forwardX;
    for(let row=1;row<=16;row++){
      const z=(row*row*.055)+.18, sy=horizon+(height*.52)/z;
      if(sy>height)continue;
      ctx.beginPath();ctx.moveTo(0,sy);ctx.lineTo(width,sy);ctx.stroke();
    }
    for(let k=-9;k<=9;k++){
      const vx=width/2+k*width*.055;
      ctx.beginPath();ctx.moveTo(width/2,horizon);ctx.lineTo(vx,height);ctx.stroke();
    }
    // Pools of warm light on the vault's concrete floor.
    ctx.globalAlpha=.08;const glow=ctx.createRadialGradient(width*.5,horizon+height*.14,2,width*.5,horizon+height*.14,width*.42);
    glow.addColorStop(0,'#e67842');glow.addColorStop(1,'transparent');ctx.fillStyle=glow;ctx.fillRect(0,horizon,width,height-horizon);
    ctx.restore();
  }
  function drawSprites(horizon,strip,rays) {
    const sprites=[];
    for(const e of enemies) if(e.alive) sprites.push({x:e.x,y:e.y,type:'enemy',ref:e,dist:Math.hypot(e.x-player.x,e.y-player.y)});
    if(bullet) sprites.push({x:bullet.x,y:bullet.y,type:'bullet',ref:bullet,dist:Math.hypot(bullet.x-player.x,bullet.y-player.y)});
    sprites.sort((a,b)=>b.dist-a.dist);
    for(const s of sprites){
      const dx=s.x-player.x,dy=s.y-player.y,dist=Math.hypot(dx,dy);
      const angle=Math.atan2(dy,dx), rel=Math.atan2(Math.sin(angle-player.angle),Math.cos(angle-player.angle));
      if(Math.abs(rel)>FOV*.62||dist<.25)continue;
      const forward=dist*Math.cos(rel), sx=width/2+Math.tan(rel)/(Math.tan(FOV/2))*width/2;
      const column=Math.max(0,Math.min(rays-1,Math.floor(sx/strip)));
      if(forward>depthBuffer[column]+.18)continue;
      if(s.type==='enemy')drawEnemy(sx,horizon,forward,s.ref);
      else drawBullet(sx,horizon,forward,s.ref);
    }
  }
  function drawEnemy(sx,horizon,dist,e) {
    const size=Math.min(height*.92,height/(dist*.92)), y=horizon+size*.05+Math.sin(time*5+e.phase)*size*.012;
    const x=sx, w=size*.48;
    ctx.save();ctx.translate(x,y);ctx.globalAlpha=Math.min(1,Math.max(.4,1-dist/13));
    // Shadow, ragged silhouette, ember fissures.
    ctx.fillStyle='rgba(0,0,0,.58)';ctx.beginPath();ctx.ellipse(0,size*.48,w*.65,size*.09,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#211916';ctx.beginPath();ctx.moveTo(-w*.54,size*.42);ctx.lineTo(-w*.62,size*.12);ctx.lineTo(-w*.4,-size*.3);ctx.lineTo(-w*.24,-size*.46);ctx.lineTo(0,-size*.51);ctx.lineTo(w*.28,-size*.43);ctx.lineTo(w*.47,-size*.1);ctx.lineTo(w*.59,size*.42);ctx.closePath();ctx.fill();
    ctx.fillStyle='#8c3829';ctx.beginPath();ctx.moveTo(-w*.48,-size*.17);ctx.lineTo(-w*.79,-size*.42);ctx.lineTo(-w*.62,size*.02);ctx.lineTo(-w*.39,size*.11);ctx.fill();
    ctx.beginPath();ctx.moveTo(w*.48,-size*.17);ctx.lineTo(w*.79,-size*.42);ctx.lineTo(w*.62,size*.02);ctx.lineTo(w*.39,size*.11);ctx.fill();
    ctx.fillStyle='#a74730';ctx.beginPath();ctx.ellipse(0,-size*.16,w*.36,size*.3,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#e27442';ctx.beginPath();ctx.ellipse(0,-size*.28,w*.22,size*.15,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#ffcf79';ctx.shadowColor='#ff6535';ctx.shadowBlur=size*.09;ctx.fillRect(-w*.22,-size*.2,w*.13,size*.045);ctx.fillRect(w*.09,-size*.2,w*.13,size*.045);ctx.shadowBlur=0;
    ctx.fillStyle='#44221b';ctx.beginPath();ctx.moveTo(-w*.12,-size*.05);ctx.lineTo(0,size*.01);ctx.lineTo(w*.12,-size*.05);ctx.lineTo(w*.1,size*.04);ctx.lineTo(-w*.1,size*.04);ctx.fill();
    ctx.fillStyle='#30201a';ctx.fillRect(-w*.4,size*.12,w*.8,size*.25);ctx.fillStyle='#57291f';ctx.fillRect(-w*.38,size*.14,w*.76,size*.06);
    ctx.fillStyle='#9d3e2d';ctx.fillRect(-w*.48,size*.08,w*.13,size*.23);ctx.fillRect(w*.35,size*.08,w*.13,size*.23);
    ctx.fillStyle='#b84c32';ctx.fillRect(-w*.36,size*.36,w*.25,size*.12);ctx.fillRect(w*.11,size*.36,w*.25,size*.12);
    // Tiny health pip / threat rune
    ctx.fillStyle='rgba(255,193,128,.72)';ctx.fillRect(-2,-size*.57,4,Math.max(2,size*.018));
    ctx.restore();
  }
  function drawBullet(sx,horizon,dist,b) {
    const size=Math.min(height*.28,height/(dist*4.3)), y=horizon+size*.7+Math.sin(time*5)*size*.04;
    ctx.save();ctx.translate(sx,y);ctx.rotate(-.16);
    ctx.globalAlpha=.9;ctx.fillStyle='rgba(240,110,52,.24)';ctx.beginPath();ctx.ellipse(0,size*.26,size*.72,size*.3,0,0,Math.PI*2);ctx.fill();
    ctx.shadowColor='#ff9a4e';ctx.shadowBlur=size*.7;ctx.fillStyle='#d7793c';ctx.fillRect(-size*.48,-size*.12,size*.9,size*.24);
    ctx.fillStyle='#f7c37b';ctx.fillRect(-size*.47,-size*.1,size*.2,size*.2);ctx.fillStyle='#6b3b27';ctx.fillRect(size*.27,-size*.14,size*.13,size*.28);ctx.shadowBlur=0;
    ctx.restore();
  }
  function drawWeapon() {
    const scale=height/520, sway=Math.sin(bob*8)*3*scale, r=recoil*26*scale;
    const x=width*.51+sway, y=height+12*scale+r;
    ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
    // Arm and worn service pistol, drawn as bold hand-painted shapes.
    ctx.fillStyle='#714a3a';ctx.beginPath();ctx.moveTo(-47,-95);ctx.lineTo(40,-90);ctx.lineTo(77,30);ctx.lineTo(-85,30);ctx.closePath();ctx.fill();
    ctx.fillStyle='#a97855';ctx.beginPath();ctx.moveTo(-34,-102);ctx.lineTo(41,-99);ctx.lineTo(56,-37);ctx.lineTo(-42,-39);ctx.closePath();ctx.fill();
    ctx.fillStyle='#24282a';ctx.beginPath();ctx.moveTo(-42,-118);ctx.lineTo(39,-118);ctx.lineTo(34,-42);ctx.lineTo(-38,-40);ctx.closePath();ctx.fill();
    ctx.fillStyle='#444b4c';ctx.fillRect(-35,-121,68,31);ctx.fillStyle='#777568';ctx.fillRect(-30,-119,53,4);
    ctx.fillStyle='#171b1d';ctx.fillRect(-19,-147,37,29);ctx.fillStyle='#555b58';ctx.fillRect(-15,-143,28,21);
    ctx.fillStyle='#af5636';ctx.fillRect(-4,-140,8,7);ctx.fillStyle='#d88e50';ctx.fillRect(-2,-139,4,3);
    ctx.fillStyle='#25282a';ctx.beginPath();ctx.moveTo(-29,-41);ctx.lineTo(28,-42);ctx.lineTo(39,26);ctx.lineTo(19,63);ctx.lineTo(-20,63);ctx.lineTo(-38,24);ctx.closePath();ctx.fill();
    ctx.fillStyle='#44342b';ctx.beginPath();ctx.moveTo(-20,4);ctx.lineTo(22,4);ctx.lineTo(32,54);ctx.lineTo(15,76);ctx.lineTo(-15,76);ctx.lineTo(-28,53);ctx.closePath();ctx.fill();
    for(let yy=15;yy<58;yy+=9){ctx.fillStyle='#70513b';ctx.fillRect(-22,yy,43,3);}
    ctx.fillStyle='#df7841';ctx.fillRect(-6,-45,12,3);ctx.restore();
  }

  function update(dt) {
    time += dt;
    flash=Math.max(0,flash-dt*3.6);damageFlash=Math.max(0,damageFlash-dt*1.6);recoil=Math.max(0,recoil-dt*4.8);
    if(alertTimer>0&&(alertTimer-=dt)<=0)$('alert').classList.remove('show');
    if(!playing)return;
    let forward=0,strafe=0;
    if(keys.has('KeyW')||keys.has('ArrowUp')||touch.has('forward'))forward++;
    if(keys.has('KeyS')||keys.has('ArrowDown')||touch.has('back'))forward--;
    if(keys.has('KeyA')||touch.has('left'))strafe--;
    if(keys.has('KeyD')||touch.has('right'))strafe++;
    const len=Math.hypot(forward,strafe)||1;forward/=len;strafe/=len;
    const speed=(keys.has('ShiftLeft')?3.5:2.65)*dt;
    const dx=(Math.cos(player.angle)*forward-Math.sin(player.angle)*strafe)*speed;
    const dy=(Math.sin(player.angle)*forward+Math.cos(player.angle)*strafe)*speed;
    moveEntity(player,dx,dy,.2);
    if(forward||strafe)bob+=dt*9;
    if(bullet){bullet.pulse+=dt; if(Math.hypot(player.x-bullet.x,player.y-bullet.y)<.68){player.loaded=true;bullet=null;showAlert('ROUND RECOVERED // CHAMBERED',1.45);tone(460,.12,'triangle',.07,820);updateHud();}}
    let changed=false;
    for(const e of enemies){
      if(!e.alive)continue;
      e.phase+=dt*2.7;e.attack-=dt;
      const dxp=player.x-e.x,dyp=player.y-e.y,dist=Math.hypot(dxp,dyp);
      if(dist>1.05){const velocity=Math.min(dt*(.52+wave*.035),Math.max(0,dist-.85));moveEntity(e,dxp/dist*velocity,dyp/dist*velocity,.2);}
      else if(e.attack<=0){e.attack=1.0+Math.random()*.35;player.health=Math.max(0,player.health-(8+Math.random()*5));damageFlash=.8;tone(62,.12,'sawtooth',.09,35);showAlert('YOU ARE TAKING DAMAGE',.65);changed=true;}
    }
    if(changed)updateHud();
    if(player.health<=0){finish(false);return;}
    if(enemies.every(e=>!e.alive)){
      if(!bullet){wave++;showAlert(`SECTOR ${String(wave).padStart(2,'0')} // MORE INCOMING`,2);spawnWave();}
      else $('objective-text').textContent='RECOVER YOUR ROUND';
    }
  }
  function finish(won){
    playing=false;document.exitPointerLock?.();
    $('end-kicker').textContent=won?'VAULT SECURED':'SIGNAL LOST';
    $('end-title').innerHTML=won?'HELL\'S<br /><em>EMPTY.</em>':'YOU\'RE<br /><em>DONE.</em>';
    $('end-copy').textContent=won?`You cleared ${kills} hostiles and kept your round close.`:`The vault keeps what it takes. You dropped ${kills} hostile${kills===1?'':'s'}.`;
    endScreen.classList.remove('hidden');
  }
  function startGame(){
    reset();playing=true;startScreen.classList.add('hidden');endScreen.classList.add('hidden');
    if(innerWidth>760&&canvas.requestPointerLock)canvas.requestPointerLock();
    audioContext();
  }
  function loop(now){
    const dt=Math.min(.04,(now-last)/1000||0);last=now;update(dt);render();requestAnimationFrame(loop);
  }
  $('start-btn').addEventListener('click',startGame);
  $('restart-btn').addEventListener('click',startGame);
  canvas.addEventListener('click',()=>{if(playing)shoot();});
  document.addEventListener('pointerlockchange',()=>{pointerLocked=document.pointerLockElement===canvas;});
  document.addEventListener('mousemove',e=>{if(playing&&pointerLocked)player.angle+=e.movementX*.0023;});
  document.addEventListener('keydown',e=>{
    keys.add(e.code);
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();
    if(e.code==='Space'&&!e.repeat)shoot();
    if(e.code==='Escape'&&playing)showAlert('CLICK TO FIRE // WASD TO MOVE',1.5);
  });
  document.addEventListener('keyup',e=>keys.delete(e.code));
  let dragX=null;
  canvas.addEventListener('touchstart',e=>{if(!playing)return;dragX=e.touches[0].clientX;},{passive:true});
  canvas.addEventListener('touchmove',e=>{if(!playing||dragX===null)return;const x=e.touches[0].clientX;player.angle+=(x-dragX)*.006;dragX=x;},{passive:true});
  canvas.addEventListener('touchend',()=>{dragX=null;});
  document.querySelectorAll('[data-move]').forEach(button=>{
    const action=button.dataset.move;
    button.addEventListener('pointerdown',e=>{e.preventDefault();touch.add(action);button.setPointerCapture(e.pointerId);});
    ['pointerup','pointercancel','lostpointercapture'].forEach(type=>button.addEventListener(type,()=>touch.delete(action)));
  });
  $('fire-touch').addEventListener('pointerdown',e=>{e.preventDefault();shoot();});
  $('sound-btn').addEventListener('click',()=>{
    soundOn=!soundOn;$('sound-btn').classList.toggle('off',!soundOn);
    $('sound-btn').querySelector('span').textContent=soundOn?'SOUND ON':'SOUND OFF';
    if(soundOn)tone(520,.08,'sine',.04);
  });
  reset();requestAnimationFrame(loop);
})();
