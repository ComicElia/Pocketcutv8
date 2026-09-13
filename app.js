(() => {
"use strict";

const $ = (s) => document.querySelector(s);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
const clamp = (v,min,max) => Math.min(max,Math.max(min,v));
const fmt = (sec) => {
  sec = Math.max(0, Number(sec)||0);
  const m = Math.floor(sec/60);
  const s = sec - m*60;
  return `${String(m).padStart(2,"0")}:${s.toFixed(1).padStart(4,"0")}`;
};
const deepClone = (x) => JSON.parse(JSON.stringify(x));

const DB_NAME = "pocketcut-db-v1";
const DB_VERSION = 1;
const BACKUP_STORE = "backups";
const MEDIA_STORE = "media";
let dbPromise;

function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(BACKUP_STORE)){
        const s = db.createObjectStore(BACKUP_STORE,{keyPath:"id"});
        s.createIndex("createdAt","createdAt");
      }
      if(!db.objectStoreNames.contains(MEDIA_STORE)){
        db.createObjectStore(MEDIA_STORE,{keyPath:"id"});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}
async function dbPut(store, value){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function dbGet(store, key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(store).objectStore(store).get(key);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function dbDelete(store,key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function dbAll(store){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(store).objectStore(store).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}

const state = {
  project: {
    id: localStorage.getItem("pc-project-id") || uid(),
    name: "Untitled project",
    aspect: "16:9",
    backupInterval: 15,
    tracks: [
      {id:uid(), type:"video", name:"Video 1", clips:[]},
      {id:uid(), type:"audio", name:"Audio 1", clips:[]},
      {id:uid(), type:"subtitle", name:"Subtitles", clips:[]},
    ]
  },
  media: [],
  mediaRuntime: new Map(),
  clipRuntime: new Map(),
  selectedClipId: null,
  currentTime: 0,
  isPlaying: false,
  pixelsPerSecond: 90,
  history: [],
  future: [],
  drag: null,
  raf: 0,
  lastTick: 0,
  lastPreviewFrame: 0,
  isExporting: false,
  exportRenderLongSide: 0,
  autosaveTimer: null,
};
localStorage.setItem("pc-project-id",state.project.id);

const els = {
  canvas: $("#previewCanvas"), emptyPreview: $("#emptyPreview"), playBtn: $("#playBtn"), previewPlayBtn: $("#previewPlayBtn"), previewPanel: $("#previewPanel"),
  timeLabel: $("#timeLabel"), tracks: $("#tracks"), trackHeaders: $("#trackHeaders"),
  ruler: $("#ruler"), playhead: $("#playhead"), mediaBin: $("#mediaBin"),
  fileInput: $("#fileInput"), dropZone: $("#dropZone"), inspector: $("#inspectorBody"),
  inspectorHint: $("#inspectorHint"), projectNameLabel: $("#projectNameLabel"),
  zoom: $("#zoomRange"), fullscreenBtn: $("#fullscreenBtn"), previewStage: $("#previewStage"), subtitleDialog: $("#subtitleDialog"),
  backupDialog: $("#backupDialog"), settingsDialog: $("#settingsDialog"),
  exportDialog: $("#exportDialog")
};
const ctx = els.canvas.getContext("2d",{alpha:false,desynchronized:true}) || els.canvas.getContext("2d");

function projectDuration(){
  let max=0;
  for(const t of state.project.tracks){
    for(const c of t.clips) max=Math.max(max,c.start+c.duration);
  }
  return max;
}
function selectedClip(){
  for(const t of state.project.tracks){
    const c=t.clips.find(x=>x.id===state.selectedClipId);
    if(c) return {clip:c,track:t};
  }
  return null;
}
function snapshotForHistory(){
  return deepClone({project:state.project,selectedClipId:state.selectedClipId,currentTime:state.currentTime});
}
function commitHistory(){
  state.history.push(snapshotForHistory());
  if(state.history.length>50) state.history.shift();
  state.future.length=0;
}
function restoreHistory(s){
  state.project=s.project;
  state.selectedClipId=s.selectedClipId;
  state.currentTime=s.currentTime;
  syncSettingsUI();
  renderAll();
}
function undo(){
  if(!state.history.length) return;
  state.future.push(snapshotForHistory());
  restoreHistory(state.history.pop());
}
function redo(){
  if(!state.future.length) return;
  state.history.push(snapshotForHistory());
  restoreHistory(state.future.pop());
}

function baseProjectData(){
  return deepClone(state.project);
}
function serializeProject(){
  return {
    version:1,
    project:baseProjectData(),
    media:state.media.map(m=>({
      id:m.id,name:m.name,type:m.type,mime:m.mime,duration:m.duration,width:m.width,height:m.height,size:m.size
    })),
    note:"Media binaries are stored locally in this browser. Re-import missing media after moving this project to another device."
  };
}
function applyProjectData(data){
  if(!data?.project?.tracks) throw new Error("Invalid project file");
  commitHistory();
  state.project=data.project;
  state.media = Array.isArray(data.media)?data.media:[];
  state.selectedClipId=null;
  state.currentTime=0;
  localStorage.setItem("pc-project-id",state.project.id);
  loadMediaFromDB().then(renderAll);
  syncSettingsUI();
  scheduleAutosave();
}

function getAspect(){
  const [w,h]=state.project.aspect.split(":").map(Number);
  return w/h;
}
function preferredPreviewLongSide(){
  if(state.exportRenderLongSide>0) return state.exportRenderLongSide;
  const mobile=window.matchMedia?.("(max-width: 800px)")?.matches;
  const memory=Number(navigator.deviceMemory)||0;
  if(memory && memory<=2) return 420;
  if(mobile) return 540;
  return 720;
}
function configureCanvas(){
  const aspect=getAspect();
  const long=preferredPreviewLongSide();
  let width, height;
  if(aspect>=1){
    width=long;
    height=Math.round(long/aspect);
  }else{
    height=long;
    width=Math.round(long*aspect);
  }
  if(els.canvas.width!==width) els.canvas.width=width;
  if(els.canvas.height!==height) els.canvas.height=height;
}
function createRuntime(media){
  if(state.mediaRuntime.has(media.id)) return state.mediaRuntime.get(media.id);
  const url=media.url;
  let el=null;
  if(media.type==="video"){
    el=document.createElement("video");
    el.src=url; el.preload="auto"; el.muted=true; el.playsInline=true;
  }else if(media.type==="audio"){
    el=document.createElement("audio");
    el.src=url; el.preload="auto";
  }else if(media.type==="image"){
    el=new Image(); el.src=url;
  }
  const runtime={el,url};
  state.mediaRuntime.set(media.id,runtime);
  return runtime;
}
function mediaById(id){ return state.media.find(m=>m.id===id); }
function clipSpeed(c){
  return clamp(Number(c.speed)||1,.25,100);
}
function clipSourceSpan(c){
  return Math.max(0,(Number(c.duration)||0)*clipSpeed(c));
}
function clipLocalTime(c,t){
  const trim=Number(c.trimIn)||0;
  const speed=clipSpeed(c);
  const rel=clamp(t-c.start,0,c.duration);
  const sourceSpan=clipSourceSpan(c);
  return c.reverse
    ? trim + Math.max(0,sourceSpan-rel*speed)
    : trim + rel*speed;
}
function clipIsActive(c,t){ return t>=c.start && t<c.start+c.duration; }


function maxClipDuration(c){
  if(c.type==="image" || c.type==="subtitle") return 24*60*60;
  const media=mediaById(c.mediaId);
  if(!media || !Number.isFinite(media.duration)) return 24*60*60;
  const remaining=Math.max(0,media.duration-(Number(c.trimIn)||0));
  return Math.max(.05,remaining/clipSpeed(c));
}
function setClipDuration(c,newDuration){
  const oldDuration=Math.max(.05,Number(c.duration)||.05);
  const limit=maxClipDuration(c);
  newDuration=clamp(Number(newDuration)||oldDuration,.05,limit);
  c.duration=newDuration;

  c.fadeIn=Math.min(Number(c.fadeIn)||0,newDuration);
  c.fadeOut=Math.min(Number(c.fadeOut)||0,newDuration);

  if(Array.isArray(c.keyframes)){
    for(const k of c.keyframes){
      k.time=clamp(Number(k.time)||0,0,newDuration);
    }
    c.keyframes.sort((a,b)=>a.time-b.time);
  }

  if(state.currentTime>c.start+c.duration){
    state.currentTime=c.start+c.duration;
  }
}

function setClipSpeed(c,newSpeed){
  const oldSpeed=clipSpeed(c);
  newSpeed=clamp(Number(newSpeed)||1,.25,100);
  if(Math.abs(oldSpeed-newSpeed)<.0001){ c.speed=newSpeed; return; }

  const oldDuration=Math.max(.1,Number(c.duration)||.1);
  const newDuration=Math.max(.05,oldDuration*oldSpeed/newSpeed);
  const ratio=newDuration/oldDuration;

  c.speed=newSpeed;
  c.duration=newDuration;

  // Keep fades and transform keyframes at the same relative place in the clip.
  c.fadeIn=Math.min(newDuration,Math.max(0,Number(c.fadeIn)||0)*ratio);
  c.fadeOut=Math.min(newDuration,Math.max(0,Number(c.fadeOut)||0)*ratio);
  if(Array.isArray(c.keyframes)){
    for(const k of c.keyframes) k.time=clamp((Number(k.time)||0)*ratio,0,newDuration);
  }

  if(state.currentTime>c.start+c.duration) state.currentTime=c.start+c.duration;
  const runtime=state.clipRuntime.get(c.id);
  if(runtime?.el){
    try{ runtime.el.pause(); }catch{}
    try{ runtime.el.playbackRate=newSpeed; }catch{}
  }
}

function createClipRuntime(c, media){
  const key=c.id;
  if(state.clipRuntime.has(key)) return state.clipRuntime.get(key);
  let el;
  if(c.type==="audio"){
    el=document.createElement("audio");
    el.src=media.url;
    el.preload="auto";
  }else if(media.type==="video"){
    el=document.createElement("video");
    el.src=media.url;
    el.preload="auto";
    el.playsInline=true;
  }else{
    return null;
  }
  el.addEventListener("seeked",()=>{ if(!state.isPlaying) requestAnimationFrame(renderPreview); });
  el.addEventListener("loadeddata",()=>requestAnimationFrame(renderPreview));
  const runtime={el,url:media.url,clipId:c.id};
  state.clipRuntime.set(key,runtime);
  return runtime;
}
function previewGain(c,t){
  let gain=clamp(Number(c.volume ?? 1),0,1);
  const local=t-c.start;
  const fadeIn=Math.max(0,Number(c.fadeIn)||0);
  const fadeOut=Math.max(0,Number(c.fadeOut)||0);
  if(fadeIn>0) gain*=clamp(local/fadeIn,0,1);
  if(fadeOut>0) gain*=clamp((c.duration-local)/fadeOut,0,1);
  return clamp(gain,0,1);
}
function syncPreviewPlayback(){
  const activeIds=new Set();
  for(const track of state.project.tracks){
    for(const c of track.clips){
      const media=mediaById(c.mediaId);
      if(!media || !["audio","video"].includes(media.type)) continue;
      if(!clipIsActive(c,state.currentTime)) continue;
      if(!(track.type==="audio" || c.type==="audio" || c.type==="video")) continue;

      const runtime=createClipRuntime(c,media);
      if(!runtime) continue;
      const el=runtime.el;
      const speed=clipSpeed(c);
      try{
        el.playbackRate=speed;
        el.defaultPlaybackRate=speed;
        if("preservesPitch" in el) el.preservesPitch=true;
        if("webkitPreservesPitch" in el) el.webkitPreservesPitch=true;
      }catch{}
      activeIds.add(c.id);
      const target=clamp(clipLocalTime(c,state.currentTime),0,Math.max(0,(media.duration||0)-.01));
      const tolerance=state.isPlaying ? .35 : state.isExporting ? .20 : .035;

      if(!state.isExporting && el.readyState>=1 && Math.abs((el.currentTime||0)-target)>tolerance){
        try{ el.currentTime=target; }catch{}
      }

      const gain=previewGain(c,state.currentTime);
      el.volume=gain;
      el.muted=c.reverse || gain<=0;

      if(state.isPlaying || state.isExporting){
        if(c.reverse){
          if(!el.paused) el.pause();
          el.muted=true;
          if(el.readyState>=1 && Math.abs((el.currentTime||0)-target)>.025){
            try{el.currentTime=target;}catch{}
          }
        }else{
          if(el.paused){
            const p=el.play();
            if(p?.catch) p.catch(()=>{});
          }
          if(!state.isExporting && el.readyState>=1 && Math.abs((el.currentTime||0)-target)>.20){
            try{el.currentTime=target;}catch{}
          }
        }
      }else if(!el.paused){
        el.pause();
      }
    }
  }

  for(const [clipId,runtime] of state.clipRuntime){
    if(!activeIds.has(clipId) && !runtime.el.paused) runtime.el.pause();
  }
}
function pausePreviewPlayback(){
  for(const runtime of state.clipRuntime.values()){
    try{ runtime.el.pause(); }catch{}
  }
}

function activeSubtitle(t){
  const subs=[];
  for(const tr of state.project.tracks.filter(x=>x.type==="subtitle")){
    for(const c of tr.clips) if(clipIsActive(c,t)) subs.push(c);
  }
  return subs;
}
function activeTextOverlays(t){
  const items=[];
  for(const tr of state.project.tracks.filter(x=>x.type==="text")){
    for(const c of tr.clips) if(clipIsActive(c,t)) items.push(c);
  }
  return items;
}
function hexToRgba(hex,alpha=1){
  const clean=String(hex||"#000000").replace("#","");
  const full=clean.length===3?clean.split("").map(x=>x+x).join(""):clean.padEnd(6,"0").slice(0,6);
  const n=parseInt(full,16);
  const r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  return `rgba(${r},${g},${b},${clamp(Number(alpha)||0,0,1)})`;
}
function wrapCanvasText(ctx,text,maxWidth){
  const paragraphs=String(text||"").split(/\n/);
  const lines=[];
  for(const paragraph of paragraphs){
    const words=paragraph.split(/\s+/).filter(Boolean);
    if(!words.length){lines.push("");continue;}
    let line="";
    for(const word of words){
      const test=(line+" "+word).trim();
      if(line && ctx.measureText(test).width>maxWidth){
        lines.push(line);
        line=word;
      }else line=test;
    }
    if(line) lines.push(line);
  }
  return lines;
}

const VISUAL_KEYS=["opacity","scale","x","y","rotation"];
const KEYFRAME_EASINGS=[
  ["linear","Linear"],
  ["ease-in","Ease In"],
  ["ease-out","Ease Out"],
  ["ease-in-out","Ease In/Out"],
  ["hold","Hold"]
];
function applyKeyframeEasing(name,t){
  t=clamp(t,0,1);
  switch(name){
    case "ease-in": return t*t*t;
    case "ease-out": return 1-Math.pow(1-t,3);
    case "ease-in-out":
      return t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
    case "hold": return t>=1 ? 1 : 0;
    default: return t;
  }
}
function baseVisualProps(c){
  return {
    opacity:c.opacity ?? 1, scale:c.scale ?? 1, x:c.x ?? .5, y:c.y ?? .5, rotation:c.rotation ?? 0
  };
}
function visualPropsAt(c,t){
  const base=baseVisualProps(c);
  const frames=(c.keyframes||[]).slice().sort((a,b)=>a.time-b.time);
  if(!frames.length) return base;
  const local=clamp(t-c.start,0,c.duration);
  if(local<=frames[0].time) return {...base,...frames[0]};
  if(local>=frames[frames.length-1].time) return {...base,...frames[frames.length-1]};
  let a=frames[0], b=frames[frames.length-1];
  for(let i=0;i<frames.length-1;i++){
    if(local>=frames[i].time && local<=frames[i+1].time){a=frames[i];b=frames[i+1];break;}
  }
  const span=Math.max(.0001,b.time-a.time);
  const rawF=clamp((local-a.time)/span,0,1);
  const f=applyKeyframeEasing(a.easing||"linear",rawF);
  const out={};
  for(const k of VISUAL_KEYS){
    const av=Number.isFinite(a[k])?a[k]:base[k];
    const bv=Number.isFinite(b[k])?b[k]:base[k];
    out[k]=av+(bv-av)*f;
  }
  return out;
}
function upsertKeyframe(c,local,overrides={}){
  local=clamp(local,0,c.duration);
  c.keyframes=c.keyframes||[];
  if(!c.keyframes.length && local>.02) c.keyframes.push({time:0,...baseVisualProps(c),easing:"linear"});
  const found=c.keyframes.find(k=>Math.abs(k.time-local)<.035);
  const values={
    ...visualPropsAt(c,c.start+local),
    ...overrides,
    time:local,
    easing:overrides.easing ?? found?.easing ?? "linear"
  };
  if(found) Object.assign(found,values); else c.keyframes.push(values);
  c.keyframes.sort((a,b)=>a.time-b.time);
}
function clipOpacity(c,t){
  let op=visualPropsAt(c,t).opacity;
  const local=t-c.start;
  if(c.fadeIn>0) op*=clamp(local/c.fadeIn,0,1);
  if(c.fadeOut>0) op*=clamp((c.duration-local)/c.fadeOut,0,1);
  return op;
}
function drawFit(el,c,canvas,ctx){
  const cw=canvas.width,ch=canvas.height;
  const sourceW=el.videoWidth||el.naturalWidth||cw;
  const sourceH=el.videoHeight||el.naturalHeight||ch;
  const baseScale=Math.min(cw/sourceW,ch/sourceH);
  const props=visualPropsAt(c,state.currentTime);
  const scale=baseScale*props.scale;
  const w=sourceW*scale,h=sourceH*scale;
  const cx=props.x*cw, cy=props.y*ch;
  ctx.save();
  ctx.globalAlpha=clamp(clipOpacity(c,state.currentTime),0,1);
  ctx.translate(cx,cy);
  ctx.rotate(props.rotation*Math.PI/180);
  ctx.drawImage(el,-w/2,-h/2,w,h);
  ctx.restore();
}

function renderPreview(){
  configureCanvas();
  syncPreviewPlayback();
  ctx.fillStyle="#000"; ctx.fillRect(0,0,els.canvas.width,els.canvas.height);
  const videoTracks=state.project.tracks.filter(t=>t.type==="video"||t.type==="overlay");
  let drawn=false;
  for(const track of videoTracks){
    const active=track.clips.filter(c=>clipIsActive(c,state.currentTime));
    for(const c of active){
      const m=mediaById(c.mediaId);
      if(!m) continue;
      const r=createRuntime(m);
      if(m.type==="video"){
        const clipRuntime=createClipRuntime(c,m);
        const videoEl=clipRuntime?.el;
        if(videoEl && videoEl.readyState>=2){
          drawFit(videoEl,c,els.canvas,ctx);
          drawn=true;
        }
      } else if(m.type==="image"){
        if(r.el.complete){ drawFit(r.el,c,els.canvas,ctx); drawn=true; }
      }
    }
  }
  const subs=activeSubtitle(state.currentTime);
  for(const c of subs){
    const fontSize=Math.max(10,Math.round(els.canvas.height*(c.fontScale||0.045)));
    ctx.save();
    ctx.font=`700 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign="center";
    ctx.textBaseline="middle";

    const widthFrac=clamp(Number(c.textWidth ?? .86),.10,.98);
    const maxW=els.canvas.width*widthFrac;
    const lines=wrapCanvasText(ctx,c.text||"",maxW);
    const lineH=fontSize*1.25;
    const textH=Math.max(lineH,lines.length*lineH);
    const centerX=els.canvas.width*clamp(Number(c.x ?? .5),0,1);
    const centerY=els.canvas.height*clamp(Number(c.y ?? .90),0,1);
    const padding=Math.max(6,fontSize*.28);
    const bgOpacity=clamp(Number(c.bgOpacity ?? 0),0,1);

    if(bgOpacity>0){
      ctx.fillStyle=hexToRgba(c.bgColor||"#000000",bgOpacity);
      ctx.fillRect(
        centerX-maxW/2-padding,
        centerY-textH/2-padding,
        maxW+padding*2,
        textH+padding*2
      );
    }

    lines.forEach((ln,i)=>{
      const y=centerY-(textH/2)+(i+.5)*lineH;
      ctx.lineWidth=Math.max(3,fontSize*.12);
      ctx.strokeStyle="rgba(0,0,0,.78)";
      ctx.strokeText(ln,centerX,y);
      ctx.fillStyle=c.color||"#ffffff";
      ctx.fillText(ln,centerX,y);
    });
    ctx.restore();
  }

  const textItems=activeTextOverlays(state.currentTime);
  for(const c of textItems){
    const fontSize=Math.max(10,Math.round(els.canvas.height*(c.fontScale||0.06)));
    ctx.save();
    ctx.font=`${c.fontWeight||700} ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign="center";
    ctx.textBaseline="middle";

    const widthFrac=clamp(Number(c.textWidth ?? .55),.08,.98);
    const maxW=els.canvas.width*widthFrac;
    const lines=wrapCanvasText(ctx,c.text||"Text",maxW);
    const lineH=fontSize*1.22;
    const textH=Math.max(lineH,lines.length*lineH);
    const centerX=els.canvas.width*clamp(Number(c.x ?? .5),0,1);
    const centerY=els.canvas.height*clamp(Number(c.y ?? .5),0,1);
    const padding=Math.max(6,fontSize*.28);
    const bgOpacity=clamp(Number(c.bgOpacity ?? 0),0,1);

    if(bgOpacity>0){
      ctx.fillStyle=hexToRgba(c.bgColor||"#000000",bgOpacity);
      ctx.fillRect(
        centerX-maxW/2-padding,
        centerY-textH/2-padding,
        maxW+padding*2,
        textH+padding*2
      );
    }

    lines.forEach((ln,i)=>{
      const y=centerY-(textH/2)+(i+.5)*lineH;
      ctx.fillStyle=c.color||"#ffffff";
      ctx.fillText(ln,centerX,y);
    });
    ctx.restore();
  }

  els.emptyPreview.style.display = drawn || subs.length || textItems.length ? "none" : "flex";
}

function renderMediaBin(){
  els.mediaBin.innerHTML="";
  if(!state.media.length){
    const p=document.createElement("div");
    p.className="placeholder"; p.textContent="Imported media appears here.";
    els.mediaBin.appendChild(p); return;
  }
  for(const m of state.media){
    const card=document.createElement("div");
    card.className="media-card";
    card.draggable=true;
    card.dataset.mediaId=m.id;
    card.addEventListener("dragstart",(e)=>{
      e.dataTransfer.effectAllowed="copy";
      e.dataTransfer.setData("text/pocketcut-media-id",m.id);
      e.dataTransfer.setData("text/plain",m.id);
      card.classList.add("dragging-media");
    });
    card.addEventListener("dragend",()=>card.classList.remove("dragging-media"));
    const thumb=document.createElement("div"); thumb.className="media-thumb";
    const r=createRuntime(m);
    if(m.type==="image"){
      const img=document.createElement("img"); img.src=m.url; thumb.appendChild(img);
    } else if(m.type==="video"){
      const v=document.createElement("video"); v.src=m.url; v.muted=true; v.preload="metadata"; thumb.appendChild(v);
    } else thumb.textContent="AUDIO";
    const name=document.createElement("div"); name.className="media-name"; name.textContent=m.name;
    const meta=document.createElement("div"); meta.className="media-meta";
    meta.textContent=`${m.type}${m.duration?` • ${fmt(m.duration)}`:""}`;
    const add=document.createElement("button"); add.textContent="Add to timeline";
    add.onclick=()=>{
      const selected=selectedClip();
      if(selected && trackAcceptsMedia(selected.track,m)){
        addMediaToTrack(m.id,selected.track,state.currentTime);
      }else{
        addMediaToTimeline(m.id);
      }
    };
    card.append(thumb,name,meta,add);
    els.mediaBin.appendChild(card);
  }
}
function timelineWidth(){
  return Math.max(800,(projectDuration()+10)*state.pixelsPerSecond);
}
function renderRuler(){
  const width=timelineWidth(); els.ruler.style.width=width+"px";
  els.ruler.innerHTML="";
  const dur=width/state.pixelsPerSecond;
  const step=state.pixelsPerSecond>120?1:state.pixelsPerSecond>70?2:5;
  for(let t=0;t<=dur;t+=step){
    const mark=document.createElement("div"); mark.className="ruler-mark";
    mark.style.left=(t*state.pixelsPerSecond)+"px";
    mark.textContent=fmt(t).slice(0,5);
    els.ruler.appendChild(mark);
  }
}
function renderTracks(){
  els.tracks.innerHTML=""; els.trackHeaders.innerHTML="";
  const width=timelineWidth(); els.tracks.style.width=width+"px";
  for(const track of state.project.tracks){
    const header=document.createElement("div"); header.className="track-header";
    const label=document.createElement("span"); label.textContent=track.name;
    const del=document.createElement("button"); del.textContent="×"; del.title="Delete track";
    del.onclick=()=>deleteTrack(track.id);
    header.append(label,del); els.trackHeaders.appendChild(header);

    const row=document.createElement("div"); row.className="track-row"; row.dataset.trackId=track.id;
    row.style.width=width+"px";
    row.addEventListener("pointerdown",(e)=>onTimelinePointerDown(e,track));
    row.addEventListener("dragover",(e)=>{
      const mediaId=e.dataTransfer.getData("text/pocketcut-media-id")||e.dataTransfer.getData("text/plain");
      const media=mediaById(mediaId);
      if(!trackAcceptsMedia(track,media)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect="copy";
      row.classList.add("media-drop-target");
    });
    row.addEventListener("dragleave",(e)=>{
      if(!row.contains(e.relatedTarget)) row.classList.remove("media-drop-target");
    });
    row.addEventListener("drop",(e)=>{
      e.preventDefault();
      row.classList.remove("media-drop-target");
      const mediaId=e.dataTransfer.getData("text/pocketcut-media-id")||e.dataTransfer.getData("text/plain");
      const media=mediaById(mediaId);
      if(!trackAcceptsMedia(track,media)) return;
      const rect=row.getBoundingClientRect();
      const scrollLeft=row.parentElement?.scrollLeft||0;
      const x=e.clientX-rect.left+scrollLeft;
      const startTime=Math.max(0,x/state.pixelsPerSecond);
      addMediaToTrack(mediaId,track,startTime);
    });
    for(const c of track.clips){
      const div=document.createElement("div");
      div.className=`clip ${c.type||track.type}${c.reverse?" reverse":""}${c.id===state.selectedClipId?" selected":""}`;
      div.dataset.clipId=c.id;
      div.style.left=(c.start*state.pixelsPerSecond)+"px";
      div.style.width=Math.max(24,c.duration*state.pixelsPerSecond)+"px";
      const title=document.createElement("div"); title.className="clip-title";
      title.textContent=(c.type==="subtitle"||c.type==="text")?(c.text||(c.type==="text"?"Text":"Subtitle")):(mediaById(c.mediaId)?.name||"Missing media");
      const meta=document.createElement("div"); meta.className="clip-meta";
      meta.textContent=`${fmt(c.start)} • ${fmt(c.duration)}${(["video","audio"].includes(c.type) && Math.abs(clipSpeed(c)-1)>.001)?` • ${clipSpeed(c)}×`:""}`;
      div.append(title,meta);
      if((c.type==="video"||c.type==="image") && (c.keyframes||[]).length){
        for(const k of c.keyframes){
          const marker=document.createElement("span"); marker.className="keyframe-marker";
          marker.style.left=`${clamp(k.time/c.duration,0,1)*100}%`; marker.title=`Keyframe ${fmt(k.time)} • ${k.easing||"linear"}`;
          div.appendChild(marker);
        }
      }
      const resizeHandle=document.createElement("span");
      resizeHandle.className="clip-resize-handle";
      resizeHandle.title=c.type==="image"?"Drag to change how long this image stays on screen":"Drag to change clip duration";
      resizeHandle.addEventListener("pointerdown",(e)=>startClipResize(e,c,track));
      div.appendChild(resizeHandle);
      div.addEventListener("pointerdown",(e)=>startClipDrag(e,c,track));
      div.addEventListener("click",(e)=>{e.stopPropagation();state.selectedClipId=c.id;renderAll();});
      row.appendChild(div);
    }
    els.tracks.appendChild(row);
  }
  updatePlayhead();
}
function renderInspector(){
  const sel=selectedClip();
  els.inspector.innerHTML="";
  if(!sel){
    els.inspectorHint.textContent="Select a clip";
    const p=document.createElement("div"); p.className="placeholder"; p.textContent="Clip controls will appear here.";
    els.inspector.appendChild(p); return;
  }
  const {clip:c}=sel;
  els.inspectorHint.textContent=c.type==="subtitle"?"Subtitle selected":c.type==="text"?"Text selected":"Clip selected";
  const visualNow=(c.type==="video"||c.type==="image")?visualPropsAt(c,state.currentTime):null;
  const textFields = [
    ["Text","text","text"],["Start","start","number"],["Duration","duration","number"],
    ["Text size","fontScale","number"],["Width","textWidth","number"],
    ["X position","x","number"],["Y position","y","number"],
    ["Text color","color","color"],["Box color","bgColor","color"],["Box opacity","bgOpacity","number"]
  ];
  const fields = c.type==="subtitle" ? textFields : c.type==="text" ? textFields : [
    ["Start","start","number"],["Duration","duration","number"],
    ...(["video","audio"].includes(c.type) ? [["Speed ×","speed","number"]] : []),
    ["Trim in","trimIn","number"],
    ["Fade in","fadeIn","number"],["Fade out","fadeOut","number"],["Opacity","opacity","number"],
    ["Scale","scale","number"],["X position","x","number"],["Y position","y","number"],
    ["Rotation","rotation","number"],["Volume","volume","number"]
  ];
  for(const [label,key,type] of fields){
    const lab=document.createElement("label"); lab.textContent=label;
    const input=document.createElement(type==="text"?"textarea":"input");
    if(type!=="text") input.type=type;
    if(type==="number"){
      input.step=(["start","duration","trimIn","fadeIn","fadeOut"].includes(key))?"0.1":"0.01";
      if(["opacity","x","y","bgOpacity"].includes(key)){input.min="0";input.max="1";}
      if(key==="textWidth"){input.min=".08";input.max=".98";input.step=".01";}
      if(key==="scale"){input.min=".05";input.max="5";}
      if(key==="volume"){input.min="0";input.max="2";}
      if(key==="speed"){input.min=".25";input.max="100";input.step=".25";}
      if(key==="fontScale"){input.min=".015";input.max=".20";input.step=".005";}
    }
    input.value=(visualNow && VISUAL_KEYS.includes(key)) ? visualNow[key] : (c[key] ?? defaultClipValue(key));
    input.onchange=()=>{
      commitHistory();
      const value=type==="number"?Number(input.value):input.value;
      if(key==="speed"){
        setClipSpeed(c,value);
      }else if(key==="duration"){
        setClipDuration(c,value);
      }else if(visualNow && VISUAL_KEYS.includes(key) && (c.keyframes||[]).length && state.currentTime>=c.start && state.currentTime<=c.start+c.duration){
        upsertKeyframe(c,state.currentTime-c.start,{[key]:value});
      }else c[key]=value;
      renderAll();
    };
    lab.appendChild(input); els.inspector.appendChild(lab);
  }
  if(c.type==="image"){
    const durationTools=document.createElement("div");
    durationTools.className="duration-tools";

    const minus=document.createElement("button");
    minus.type="button";
    minus.textContent="−1s";
    minus.onclick=()=>{commitHistory();setClipDuration(c,c.duration-1);renderAll();};

    const plus=document.createElement("button");
    plus.type="button";
    plus.textContent="+1s";
    plus.onclick=()=>{commitHistory();setClipDuration(c,c.duration+1);renderAll();};

    const plusFive=document.createElement("button");
    plusFive.type="button";
    plusFive.textContent="+5s";
    plusFive.onclick=()=>{commitHistory();setClipDuration(c,c.duration+5);renderAll();};

    durationTools.append(minus,plus,plusFive);
    els.inspector.appendChild(durationTools);
  }

  if(c.type==="video"||c.type==="image") renderKeyframeEditor(c);
}
function renderKeyframeEditor(c){
  const box=document.createElement("div"); box.className="keyframe-editor";
  const head=document.createElement("div"); head.className="keyframe-head";
  const titleWrap=document.createElement("div");
  const title=document.createElement("strong"); title.textContent="Keyframes";
  const hint=document.createElement("span"); hint.textContent="Position • scale • rotation • opacity • easing";
  titleWrap.append(title,hint);
  const add=document.createElement("button"); add.textContent="◇ Add/update at playhead";
  add.onclick=()=>{
    if(state.currentTime<c.start || state.currentTime>c.start+c.duration) state.currentTime=c.start;
    commitHistory(); upsertKeyframe(c,state.currentTime-c.start); renderAll();
  };
  head.append(titleWrap,add); box.appendChild(head);
  const dragHelp=document.createElement("div"); dragHelp.className="keyframe-drag-help";
  dragHelp.textContent="To animate movement: add a keyframe, move the playhead, drag the selected video/image directly in the preview, then add or update the next keyframe.";
  box.appendChild(dragHelp);
  const list=document.createElement("div"); list.className="keyframe-list";
  const frames=(c.keyframes||[]).slice().sort((a,b)=>a.time-b.time);
  if(!frames.length){
    const empty=document.createElement("span"); empty.className="muted";
    empty.textContent="No keyframes yet. Move the playhead, set the transform, then add a keyframe."; list.appendChild(empty);
  }else{
    frames.forEach((k,index)=>{
      const row=document.createElement("div"); row.className="keyframe-row";
      const jump=document.createElement("button"); jump.textContent=`◇ ${fmt(k.time)}`;
      jump.onclick=()=>{state.currentTime=c.start+k.time;renderAll();};

      const easing=document.createElement("select");
      easing.className="keyframe-easing";
      easing.title=index===frames.length-1 ? "Easing is used when another keyframe follows this one." : "Transition from this keyframe to the next.";
      for(const [value,label] of KEYFRAME_EASINGS){
        const option=document.createElement("option");
        option.value=value; option.textContent=label;
        easing.appendChild(option);
      }
      easing.value=k.easing||"linear";
      easing.onchange=()=>{
        commitHistory();
        k.easing=easing.value;
        renderPreview();
        renderTracks();
      };

      const del=document.createElement("button"); del.textContent="Delete";
      del.onclick=()=>{commitHistory();c.keyframes.splice(c.keyframes.indexOf(k),1);renderAll();};
      row.append(jump,easing,del); list.appendChild(row);
    });
  }
  box.appendChild(list); els.inspector.appendChild(box);
}
function defaultClipValue(k){
  return ({trimIn:0,fadeIn:0,fadeOut:0,opacity:1,scale:1,x:.5,y:.5,rotation:0,volume:1,speed:1,fontScale:.045,textWidth:.7,color:"#ffffff",bgColor:"#000000",bgOpacity:0}[k] ?? 0);
}
function renderAll(){
  els.projectNameLabel.textContent=state.project.name;
  const sel=selectedClip();
  els.previewStage?.classList.toggle("position-edit",!!sel && ["video","image","text","subtitle"].includes(sel.clip.type) && !state.isPlaying);
  renderMediaBin(); renderRuler(); renderTracks(); renderInspector(); renderPreview(); updateTimeLabel();
  $("#undoBtn").disabled=!state.history.length; $("#redoBtn").disabled=!state.future.length;
}
function updatePlayhead(){
  els.playhead.style.left=(state.currentTime*state.pixelsPerSecond)+"px";
}
function updateTimeLabel(){ els.timeLabel.textContent=`${fmt(state.currentTime)} / ${fmt(projectDuration())}`; }

async function readMediaMeta(file,url,type){
  if(type==="image"){
    return await new Promise(resolve=>{
      const img=new Image();
      img.onload=()=>resolve({duration:5,width:img.naturalWidth,height:img.naturalHeight});
      img.onerror=()=>resolve({duration:5,width:0,height:0});
      img.src=url;
    });
  }
  const el=document.createElement(type==="video"?"video":"audio");
  el.preload="metadata"; el.src=url;
  return await new Promise(resolve=>{
    el.onloadedmetadata=()=>resolve({duration:Number.isFinite(el.duration)?el.duration:10,width:el.videoWidth||0,height:el.videoHeight||0});
    el.onerror=()=>resolve({duration:10,width:0,height:0});
  });
}
function detectType(file){
  if(file.type.startsWith("video/")) return "video";
  if(file.type.startsWith("audio/")) return "audio";
  if(file.type.startsWith("image/")) return "image";
  return null;
}
async function importFiles(files){
  for(const file of files){
    const type=detectType(file); if(!type) continue;
    const id=uid(); const url=URL.createObjectURL(file);
    const meta=await readMediaMeta(file,url,type);
    const media={id,name:file.name,type,mime:file.type,size:file.size,url,...meta};
    state.media.push(media);
    await dbPut(MEDIA_STORE,{id,blob:file,meta:{name:file.name,type,mime:file.type,size:file.size,...meta}});
  }
  renderAll();
}
async function loadMediaFromDB(){
  pausePreviewPlayback();
  state.clipRuntime.clear();
  state.mediaRuntime.forEach(r=>{try{URL.revokeObjectURL(r.url)}catch{}});
  state.mediaRuntime.clear();
  const loaded=[];
  for(const m of state.media){
    const row=await dbGet(MEDIA_STORE,m.id);
    if(row?.blob){
      loaded.push({...m,...row.meta,url:URL.createObjectURL(row.blob)});
    }else loaded.push({...m,url:""});
  }
  state.media=loaded;
}

function preferredTrackForMedia(m){
  if(m.type==="audio") return state.project.tracks.find(t=>t.type==="audio");
  return state.project.tracks.find(t=>t.type==="video");
}
function trackAcceptsMedia(track,m){
  if(!track||!m) return false;
  if(m.type==="audio") return track.type==="audio";
  if(m.type==="video"||m.type==="image") return track.type==="video"||track.type==="overlay";
  return false;
}
function addMediaToTrack(mediaId,track,startTime){
  const m=mediaById(mediaId); if(!m||!trackAcceptsMedia(track,m)) return false;
  commitHistory();
  const c={
    id:uid(),
    type:m.type==="audio"?"audio":m.type==="image"?"image":"video",
    mediaId:m.id,
    start:Math.max(0,Number(startTime)||0),
    duration:m.type==="image"?5:Math.max(.1,m.duration||5),
    trimIn:0,
    speed:1,
    fadeIn:0,
    fadeOut:0,
    opacity:1,
    scale:1,
    x:.5,
    y:.5,
    rotation:0,
    volume:1
  };
  track.clips.push(c);
  state.selectedClipId=c.id;
  state.currentTime=c.start;
  renderAll();
  return true;
}
function addMediaToTimeline(mediaId){
  const m=mediaById(mediaId); if(!m) return;
  let track=preferredTrackForMedia(m);
  if(!track){
    track={id:uid(),type:m.type==="audio"?"audio":"video",name:m.type==="audio"?"Audio":"Video",clips:[]};
    state.project.tracks.push(track);
  }
  addMediaToTrack(mediaId,track,state.currentTime);
}
function addTrack(type){
  commitHistory();
  const count=state.project.tracks.filter(t=>t.type===type).length+1;
  state.project.tracks.push({id:uid(),type,name:`${type[0].toUpperCase()+type.slice(1)} ${count}`,clips:[]});
  renderAll();
}
function deleteTrack(id){
  const t=state.project.tracks.find(x=>x.id===id); if(!t) return;
  if(t.clips.length && !confirm("Delete this track and all clips on it?")) return;
  commitHistory();
  state.project.tracks=state.project.tracks.filter(x=>x.id!==id);
  if(t.clips.some(c=>c.id===state.selectedClipId)) state.selectedClipId=null;
  renderAll();
}
function splitSelected(){
  const sel=selectedClip(); if(!sel) return;
  const {clip:c,track}=sel;
  const at=state.currentTime;
  if(at<=c.start+.05 || at>=c.start+c.duration-.05) return;
  commitHistory();
  const originalDuration=c.duration;
  const originalTrim=Number(c.trimIn)||0;
  const speed=clipSpeed(c);
  const leftDur=at-c.start;
  const right=deepClone(c); right.id=uid(); right.start=at; right.duration=originalDuration-leftDur;
  if(c.type!=="subtitle"){
    if(c.reverse){
      c.trimIn=originalTrim+(originalDuration-leftDur)*speed;
      right.trimIn=originalTrim;
    }else{
      right.trimIn=originalTrim+leftDur*speed;
    }
  }
  c.duration=leftDur;
  if(Array.isArray(c.keyframes)){
    const originalFrames=deepClone(c.keyframes);
    c.keyframes=originalFrames.filter(k=>k.time<=leftDur+.0001).map(k=>({...k,time:clamp(k.time,0,leftDur)}));
    right.keyframes=originalFrames.filter(k=>k.time>=leftDur-.0001).map(k=>({...k,time:clamp(k.time-leftDur,0,right.duration)}));
  }
  track.clips.push(right); state.selectedClipId=right.id; renderAll();
}
function duplicateSelected(){
  const sel=selectedClip(); if(!sel) return;
  commitHistory();
  const copy=deepClone(sel.clip); copy.id=uid(); copy.start=sel.clip.start+sel.clip.duration+.05;
  sel.track.clips.push(copy); state.selectedClipId=copy.id; renderAll();
}
function deleteSelected(){
  const sel=selectedClip(); if(!sel) return;
  commitHistory();
  sel.track.clips=sel.track.clips.filter(c=>c.id!==sel.clip.id);
  state.selectedClipId=null; renderAll();
}
function detachAudio(){
  const sel=selectedClip(); if(!sel || sel.clip.type!=="video") return;
  const audioTrack=state.project.tracks.find(t=>t.type==="audio") || {id:uid(),type:"audio",name:"Audio",clips:[]};
  if(!state.project.tracks.includes(audioTrack)) state.project.tracks.push(audioTrack);
  commitHistory();
  const c=sel.clip;
  audioTrack.clips.push({
    id:uid(),type:"audio",mediaId:c.mediaId,start:c.start,duration:c.duration,trimIn:c.trimIn||0,
    fadeIn:c.fadeIn||0,fadeOut:c.fadeOut||0,volume:1,speed:clipSpeed(c),reverse:!!c.reverse,detachedFrom:c.id
  });
  c.volume=0;
  renderAll();
}
function reverseSelected(){
  const sel=selectedClip();
  if(!sel || !["video","audio"].includes(sel.clip.type)) return;
  commitHistory();
  sel.clip.reverse=!sel.clip.reverse;
  pausePreviewPlayback();
  state.clipRuntime.delete(sel.clip.id);
  renderAll();
}
function addTextOverlay(){
  commitHistory();
  let track=state.project.tracks.find(t=>t.type==="text");
  if(!track){
    track={id:uid(),type:"text",name:"Text",clips:[]};
    // Keep text above subtitles in the visual stack/order.
    const subIndex=state.project.tracks.findIndex(t=>t.type==="subtitle");
    if(subIndex>=0) state.project.tracks.splice(subIndex,0,track);
    else state.project.tracks.push(track);
  }
  const c={
    id:uid(),
    type:"text",
    text:"Text",
    start:state.currentTime,
    duration:5,
    fontScale:.06,
    textWidth:.55,
    x:.5,
    y:.5,
    color:"#ffffff",
    bgColor:"#000000",
    bgOpacity:0
  };
  track.clips.push(c);
  state.selectedClipId=c.id;
  renderAll();
}
function addSubtitle(){
  $("#subtitleStart").value=state.currentTime.toFixed(1);
  $("#subtitleText").value="";
  els.subtitleDialog.showModal();
}
function saveSubtitle(){
  const text=$("#subtitleText").value.trim(); if(!text) return;
  const start=Math.max(0,Number($("#subtitleStart").value)||0);
  const duration=Math.max(.1,Number($("#subtitleDuration").value)||3);
  commitHistory();
  let t=state.project.tracks.find(x=>x.type==="subtitle");
  if(!t){t={id:uid(),type:"subtitle",name:"Subtitles",clips:[]};state.project.tracks.push(t);}
  const c={id:uid(),type:"subtitle",text,start,duration,fontScale:.045,textWidth:.86,x:.5,y:.90,color:"#ffffff",bgColor:"#000000",bgOpacity:0};
  t.clips.push(c); state.selectedClipId=c.id;
  els.subtitleDialog.close(); renderAll();
}

function onTimelinePointerDown(e,track){
  if(e.target.closest(".clip")) return;
  const rect=e.currentTarget.getBoundingClientRect();
  const x=e.clientX-rect.left+e.currentTarget.parentElement.scrollLeft;
  state.currentTime=clamp(x/state.pixelsPerSecond,0,projectDuration()+10);
  renderAll();
}

function startClipResize(e,c,track){
  e.preventDefault();
  e.stopPropagation();
  state.selectedClipId=c.id;
  commitHistory();

  const startX=e.clientX;
  const originalDuration=Math.max(.05,Number(c.duration)||.05);
  e.currentTarget.setPointerCapture?.(e.pointerId);

  const move=(ev)=>{
    const dx=ev.clientX-startX;
    const proposed=originalDuration + dx/state.pixelsPerSecond;
    setClipDuration(c,proposed);
    renderRuler();
    renderTracks();
    renderInspector();
    renderPreview();
    updateTimeLabel();
  };

  const up=()=>{
    window.removeEventListener("pointermove",move);
    window.removeEventListener("pointerup",up);
    renderAll();
  };

  window.addEventListener("pointermove",move);
  window.addEventListener("pointerup",up);
}

function startClipDrag(e,c,track){
  e.stopPropagation();
  state.selectedClipId=c.id;
  commitHistory();
  state.drag={clip:c,track,startX:e.clientX,startY:e.clientY,origStart:c.start};
  e.currentTarget.setPointerCapture?.(e.pointerId);

  const isCompatible=(target)=>{
    if(!target) return false;
    if(c.type==="audio") return target.type==="audio";
    if(c.type==="subtitle") return target.type==="subtitle";
    if(c.type==="text") return target.type==="text";
    return target.type==="video" || target.type==="overlay";
  };

  const move=(ev)=>{
    if(!state.drag) return;
    const dx=ev.clientX-state.drag.startX;
    c.start=Math.max(0,state.drag.origStart+dx/state.pixelsPerSecond);
    renderRuler();
    renderTracks();
    renderPreview();
    updateTimeLabel();

    document.querySelectorAll(".track-row.track-drop-target").forEach(x=>x.classList.remove("track-drop-target"));
    const row=document.elementFromPoint(ev.clientX,ev.clientY)?.closest?.(".track-row");
    const target=row && state.project.tracks.find(t=>t.id===row.dataset.trackId);
    if(row && isCompatible(target)) row.classList.add("track-drop-target");
  };

  const up=(ev)=>{
    document.querySelectorAll(".track-row.track-drop-target").forEach(x=>x.classList.remove("track-drop-target"));
    const row=document.elementFromPoint(ev.clientX,ev.clientY)?.closest?.(".track-row");
    const target=row && state.project.tracks.find(t=>t.id===row.dataset.trackId);
    if(target && target.id!==track.id && isCompatible(target)){
      track.clips=track.clips.filter(x=>x.id!==c.id);
      target.clips.push(c);
    }
    state.drag=null;
    window.removeEventListener("pointermove",move);
    window.removeEventListener("pointerup",up);
    renderAll();
  };

  window.addEventListener("pointermove",move);
  window.addEventListener("pointerup",up);
}

function tick(ts){
  if(!state.isPlaying) return;
  if(!state.lastTick) state.lastTick=ts;
  const dt=(ts-state.lastTick)/1000; state.lastTick=ts;
  state.currentTime+=dt;
  const dur=projectDuration();
  if(state.currentTime>=dur){state.currentTime=dur;pause();return;}

  const mobile=window.matchMedia?.("(max-width: 800px)")?.matches;
  const targetFps=mobile?24:30;
  const interval=1000/targetFps;
  if(!state.lastPreviewFrame || ts-state.lastPreviewFrame>=interval){
    state.lastPreviewFrame=ts;
    renderPreview();
    updatePlayhead();
    updateTimeLabel();
  }
  state.raf=requestAnimationFrame(tick);
}
function syncPlayButtons(){
  if(state.isPlaying){
    els.playBtn.textContent="❚❚ Pause";
    if(els.previewPlayBtn){
      els.previewPlayBtn.classList.add("is-playing");
      els.previewPlayBtn.setAttribute("aria-label","Video is playing");
    }
  }else{
    els.playBtn.textContent="▶ Play";
    if(els.previewPlayBtn){
      els.previewPlayBtn.classList.remove("is-playing");
      els.previewPlayBtn.innerHTML='<span class="preview-play-icon">▶</span><span class="preview-play-label">Play</span>';
      els.previewPlayBtn.setAttribute("aria-label","Play video");
    }
  }
}
function play(){
  if(projectDuration()<=0) return;
  if(state.currentTime>=projectDuration()) state.currentTime=0;
  state.isPlaying=true;
  state.lastTick=0;
  state.lastPreviewFrame=0;
  syncPlayButtons();
  // Start media immediately from the user gesture so mobile browsers allow playback.
  syncPreviewPlayback();
  state.raf=requestAnimationFrame(tick);
}
function pause(){
  state.isPlaying=false;
  pausePreviewPlayback();
  syncPlayButtons();
  cancelAnimationFrame(state.raf);
  renderPreview();
}
function togglePlay(){state.isPlaying?pause():play();}
function seekBy(delta){
  state.currentTime=clamp(state.currentTime+delta,0,projectDuration());
  renderAll();
}

async function createBackup(kind="auto"){
  const entry={id:uid(),projectId:state.project.id,kind,createdAt:Date.now(),data:serializeProject()};
  await dbPut(BACKUP_STORE,entry);
  const all=(await dbAll(BACKUP_STORE)).filter(x=>x.projectId===state.project.id).sort((a,b)=>b.createdAt-a.createdAt);
  for(const old of all.slice(5)) await dbDelete(BACKUP_STORE,old.id);
  if(els.backupDialog.open) renderBackupList();
}
async function renderBackupList(){
  const list=$("#backupList"); list.innerHTML="";
  const all=(await dbAll(BACKUP_STORE)).filter(x=>x.projectId===state.project.id).sort((a,b)=>b.createdAt-a.createdAt);
  if(!all.length){list.innerHTML='<div class="placeholder">No backups yet.</div>';return;}
  for(const b of all){
    const item=document.createElement("div"); item.className="backup-item";
    const info=document.createElement("div");
    const title=document.createElement("strong"); title.textContent=b.kind==="auto"?"Autosave":"Manual backup";
    const small=document.createElement("small");
    const d=new Date(b.createdAt);
    const dur=Math.max(...b.data.project.tracks.flatMap(t=>t.clips.map(c=>c.start+c.duration)),0);
    small.textContent=`${d.toLocaleString()} • ${fmt(dur)} project`;
    info.append(title,small);
    const acts=document.createElement("div"); acts.className="backup-item-actions";
    const restore=document.createElement("button"); restore.textContent="Restore";
    restore.onclick=()=>{if(confirm("Restore this backup? Current unsaved changes will be replaced.")){applyProjectData(b.data);els.backupDialog.close();}};
    const del=document.createElement("button"); del.textContent="Delete"; del.onclick=async()=>{await dbDelete(BACKUP_STORE,b.id);renderBackupList();};
    acts.append(restore,del); item.append(info,acts); list.appendChild(item);
  }
}
function scheduleAutosave(){
  if(state.autosaveTimer) clearInterval(state.autosaveTimer);
  const mins=Number(state.project.backupInterval)||0;
  if(mins>0) state.autosaveTimer=setInterval(()=>createBackup("auto"),mins*60*1000);
  updateBackupWindowText();
}
function updateBackupWindowText(){
  const mins=Number(state.project.backupInterval)||0;
  $("#backupWindowText").textContent=mins?`Up to approximately ${mins*5} minutes of autosave history (5 backups total).`:"Automatic backups are disabled.";
}
function syncSettingsUI(){
  $("#projectNameInput").value=state.project.name;
  $("#backupIntervalSelect").value=String(state.project.backupInterval??15);
  $("#aspectSelect").value=state.project.aspect||"16:9";
  updateBackupWindowText();
}
function saveSettings(){
  commitHistory();
  state.project.name=$("#projectNameInput").value.trim()||"Untitled project";
  state.project.backupInterval=Number($("#backupIntervalSelect").value);
  state.project.aspect=$("#aspectSelect").value;
  els.settingsDialog.close();
  scheduleAutosave(); renderAll();
}
function downloadJSON(){
  const blob=new Blob([JSON.stringify(serializeProject(),null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=`${state.project.name.replace(/[^\w-]+/g,"_")||"pocketcut"}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function importProjectFile(file){
  const text=await file.text(); applyProjectData(JSON.parse(text));
}
async function restoreLatestSession(){
  const all=(await dbAll(BACKUP_STORE)).filter(x=>x.projectId===state.project.id).sort((a,b)=>b.createdAt-a.createdAt);
  if(all.length){
    state.project=all[0].data.project;
    state.media=all[0].data.media||[];
    await loadMediaFromDB();
  }
}

async function syncVideoFramesForTime(t){
  const jobs=[];
  for(const track of state.project.tracks){
    if(!(track.type==="video" || track.type==="overlay")) continue;
    for(const c of track.clips){
      if(c.type!=="video" || !clipIsActive(c,t)) continue;
      const media=mediaById(c.mediaId);
      if(!media) continue;
      const runtime=createClipRuntime(c,media);
      const el=runtime?.el;
      if(!el || el.readyState<1) continue;
      const target=clamp(clipLocalTime(c,t),0,Math.max(0,(media.duration||0)-.01));
      if(Math.abs((el.currentTime||0)-target)<=.018) continue;
      jobs.push(new Promise(resolve=>{
        const done=()=>{el.removeEventListener("seeked",done);resolve();};
        el.addEventListener("seeked",done,{once:true});
        try{el.currentTime=target;}catch{done();}
        setTimeout(done,180);
      }));
    }
  }
  if(jobs.length) await Promise.all(jobs);
}

async function decodeMediaAudio(mediaId,audioContext,cache){
  if(cache.has(mediaId)) return cache.get(mediaId);
  const row=await dbGet(MEDIA_STORE,mediaId);
  if(!row?.blob){cache.set(mediaId,null);return null;}
  try{
    const bytes=await row.blob.arrayBuffer();
    const decoded=await audioContext.decodeAudioData(bytes.slice(0));
    cache.set(mediaId,decoded); return decoded;
  }catch(err){
    console.warn("Could not decode audio",err); cache.set(mediaId,null); return null;
  }
}

function reversedAudioSegment(ctx,buffer,offset,duration){
  const frames=Math.max(1,Math.floor(duration*buffer.sampleRate));
  const out=ctx.createBuffer(buffer.numberOfChannels,frames,buffer.sampleRate);
  const start=Math.max(0,Math.floor(offset*buffer.sampleRate));
  for(let ch=0;ch<buffer.numberOfChannels;ch++){
    const src=buffer.getChannelData(ch);
    const dst=out.getChannelData(ch);
    for(let i=0;i<frames;i++){
      const sourceIndex=start+(frames-1-i);
      dst[i]=(sourceIndex>=0 && sourceIndex<src.length)?src[sourceIndex]:0;
    }
  }
  return out;
}

async function renderAudioMix(duration,status){
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!Offline) return {buffer:null,skipped:["Audio mixing is unavailable in this browser"]};
  const sampleRate=44100;
  const offline=new Offline(2,Math.max(1,Math.ceil(duration*sampleRate)),sampleRate);
  const cache=new Map(), skipped=[];
  const candidates=[];
  for(const track of state.project.tracks){
    for(const c of track.clips){
      const media=mediaById(c.mediaId);
      if(!media || !["audio","video"].includes(media.type)) continue;
      if(track.type==="audio" || c.type==="audio" || c.type==="video") candidates.push(c);
    }
  }
  let n=0;
  for(const c of candidates){
    n++; if(status) status.textContent=`Preparing audio ${n}/${candidates.length}…`;
    const volume=clamp(Number(c.volume ?? 1),0,2); if(volume<=0) continue;
    const buffer=await decodeMediaAudio(c.mediaId,offline,cache);
    if(!buffer){skipped.push(mediaById(c.mediaId)?.name||"Unknown media");continue;}
    const offset=Math.max(0,Number(c.trimIn)||0);
    const speed=clipSpeed(c);
    const wantedTimeline=Math.max(0,Math.min(Number(c.duration)||0,duration-c.start));
    const wantedSource=wantedTimeline*speed;
    const sourceAvailable=Math.max(0,Math.min(wantedSource,buffer.duration-offset));
    const available=sourceAvailable/speed;
    if(available<=.001 || c.start>=duration) continue;
    const src=offline.createBufferSource();
    src.buffer=c.reverse?reversedAudioSegment(offline,buffer,offset,sourceAvailable):buffer;
    src.playbackRate.setValueAtTime(speed,0);
    const gain=offline.createGain(); src.connect(gain).connect(offline.destination);
    const start=Math.max(0,c.start), end=start+available;
    const fadeIn=Math.min(Math.max(0,Number(c.fadeIn)||0),available);
    const fadeOut=Math.min(Math.max(0,Number(c.fadeOut)||0),available);
    if(fadeIn>0){gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(volume,start+fadeIn);}
    else gain.gain.setValueAtTime(volume,start);
    if(fadeOut>0){
      const fadeStart=Math.max(start+fadeIn,end-fadeOut);
      gain.gain.setValueAtTime(volume,fadeStart); gain.gain.linearRampToValueAtTime(0,end);
    }else gain.gain.setValueAtTime(volume,end);
    try{src.start(start,c.reverse?0:offset,sourceAvailable);}catch(err){console.warn(err);}
  }
  return {buffer:await offline.startRendering(),skipped:[...new Set(skipped)]};
}

async function waitForMediaReady(el,timeout=2500){
  if(el.readyState>=2) return;
  await new Promise(resolve=>{
    let finished=false;
    const done=()=>{
      if(finished) return;
      finished=true;
      el.removeEventListener("loadeddata",done);
      el.removeEventListener("canplay",done);
      el.removeEventListener("error",done);
      resolve();
    };
    el.addEventListener("loadeddata",done,{once:true});
    el.addEventListener("canplay",done,{once:true});
    el.addEventListener("error",done,{once:true});
    try{el.load?.();}catch{}
    setTimeout(done,timeout);
  });
}

async function seekMediaElement(el,time,timeout=500){
  if(!el || el.readyState<1) return;
  if(Math.abs((el.currentTime||0)-time)<=.018) return;
  await new Promise(resolve=>{
    let finished=false;
    const done=()=>{
      if(finished) return;
      finished=true;
      el.removeEventListener("seeked",done);
      resolve();
    };
    el.addEventListener("seeked",done,{once:true});
    try{
      if(typeof el.fastSeek==="function") el.fastSeek(time);
      else el.currentTime=time;
    }catch{
      done();
    }
    setTimeout(done,timeout);
  });
}

async function prepareExportVideoRuntimes(status){
  const videos=[];
  for(const track of state.project.tracks){
    if(!(track.type==="video" || track.type==="overlay")) continue;
    for(const c of track.clips){
      if(c.type!=="video") continue;
      const media=mediaById(c.mediaId);
      if(!media) continue;
      const runtime=createClipRuntime(c,media);
      if(!runtime?.el) continue;
      const el=runtime.el;
      try{el.pause();}catch{}
      el.muted=true;
      try{
        el.playbackRate=clipSpeed(c);
        el.defaultPlaybackRate=clipSpeed(c);
      }catch{}
      videos.push({c,media,el});
    }
  }

  if(status && videos.length) status.textContent="Preparing video clips…";
  await Promise.all(videos.map(async ({c,media,el})=>{
    await waitForMediaReady(el);
    const firstTime=clamp(clipLocalTime(c,c.start),0,Math.max(0,(media.duration||0)-.01));
    await seekMediaElement(el,firstTime,700);
  }));
  return videos;
}

async function syncNewExportClips(t,previousActive){
  const active=new Set();
  const jobs=[];

  for(const track of state.project.tracks){
    if(!(track.type==="video" || track.type==="overlay")) continue;
    for(const c of track.clips){
      if(c.type!=="video" || !clipIsActive(c,t)) continue;
      const media=mediaById(c.mediaId);
      if(!media) continue;
      const runtime=createClipRuntime(c,media);
      const el=runtime?.el;
      if(!el) continue;

      active.add(c.id);
      const target=clamp(clipLocalTime(c,t),0,Math.max(0,(media.duration||0)-.01));

      // On a cut/new clip, wait for the correct first frame before drawing it.
      if(!previousActive.has(c.id)){
        jobs.push((async()=>{
          try{el.pause();}catch{}
          await waitForMediaReady(el,800);
          await seekMediaElement(el,target,700);
          if(!c.reverse){
            try{
              el.playbackRate=clipSpeed(c);
              const p=el.play();
              if(p?.catch) p.catch(()=>{});
            }catch{}
          }
        })());
      }
    }
  }

  // Pause clips that just became inactive.
  for(const clipId of previousActive){
    if(active.has(clipId)) continue;
    const runtime=state.clipRuntime.get(clipId);
    try{runtime?.el?.pause();}catch{}
  }

  if(jobs.length) await Promise.all(jobs);
  return active;
}

async function exportWebM(){
  const status=$("#exportStatus"), duration=projectDuration();
  if(duration<=0){status.textContent="Nothing to export.";return;}
  if(!window.MediaRecorder){status.textContent="MediaRecorder is not supported in this browser.";return;}
  const q=Number($("#exportQuality").value), aspect=getAspect();
  const out=document.createElement("canvas");
  if(aspect>=1){out.width=Math.round(q*aspect);out.height=q;} else {out.width=q;out.height=Math.round(q/aspect);}
  const octx=out.getContext("2d",{alpha:false,desynchronized:true}) || out.getContext("2d");
  const exportFps=30;
  const videoStream=out.captureStream(exportFps);
  const oldExportLongSide=state.exportRenderLongSide;
  state.exportRenderLongSide=Math.max(out.width,out.height);
  const preparedVideos=await prepareExportVideoRuntimes(status);
  const audioMix=await renderAudioMix(duration,status);
  let audioCtx=null,audioSource=null,audioDest=null;
  const combinedTracks=[...videoStream.getVideoTracks()];
  if(audioMix.buffer){
    const AC=window.AudioContext||window.webkitAudioContext;
    if(AC){
      audioCtx=new AC(); audioDest=audioCtx.createMediaStreamDestination();
      audioSource=audioCtx.createBufferSource(); audioSource.buffer=audioMix.buffer; audioSource.connect(audioDest);
      combinedTracks.push(...audioDest.stream.getAudioTracks());
    }
  }
  const stream=new MediaStream(combinedTracks);
  const mime=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"].find(x=>MediaRecorder.isTypeSupported(x))||"video/webm";
  const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:q>=1080?12_000_000:q>=720?7_000_000:3_500_000,audioBitsPerSecond:192_000});
  const chunks=[]; rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  const oldTime=state.currentTime, oldPlaying=state.isPlaying; pause();
  status.textContent="Rendering… keep this tab open.";
  if(audioCtx) await audioCtx.resume();
  rec.start(500);
  const lead=.12; if(audioSource) audioSource.start(audioCtx.currentTime+lead);
  await new Promise(r=>setTimeout(r,lead*1000));
  state.isExporting=true;
  state.lastPreviewFrame=0;
  state.currentTime=0;
  renderPreview();

  const started=performance.now();
  let nextFrame=started;
  let exportActiveVideoClips=new Set();

  while(true){
    const now=performance.now();
    const elapsed=(now-started)/1000;
    if(elapsed>=duration) break;

    if(now>=nextFrame){
      state.currentTime=Math.min(duration,elapsed);

      // Ensure the first frame after every cut is actually decoded before drawing.
      exportActiveVideoClips=await syncNewExportClips(state.currentTime,exportActiveVideoClips);

      // Reversed clips need frame-accurate seeking throughout the clip.
      const reverseJobs=[];
      for(const track of state.project.tracks){
        if(!(track.type==="video" || track.type==="overlay")) continue;
        for(const c of track.clips){
          if(!c.reverse || c.type!=="video" || !clipIsActive(c,state.currentTime)) continue;
          const media=mediaById(c.mediaId);
          const runtime=media && createClipRuntime(c,media);
          const el=runtime?.el;
          if(!el || el.readyState<1) continue;
          const target=clamp(clipLocalTime(c,state.currentTime),0,Math.max(0,(media.duration||0)-.01));
          if(Math.abs((el.currentTime||0)-target)>.018){
            reverseJobs.push(new Promise(resolve=>{
              let finished=false;
              const done=()=>{if(finished)return;finished=true;el.removeEventListener("seeked",done);resolve();};
              el.addEventListener("seeked",done,{once:true});
              try{el.currentTime=target;}catch{done();}
              setTimeout(done,100);
            }));
          }
        }
      }
      if(reverseJobs.length) await Promise.all(reverseJobs);

      renderPreview();
      octx.clearRect(0,0,out.width,out.height);
      octx.drawImage(els.canvas,0,0,out.width,out.height);

      const frame=Math.floor(elapsed*exportFps);
      if(frame%exportFps===0){
        status.textContent=`Rendering ${Math.min(99,Math.round(elapsed/duration*100))}%`;
      }

      nextFrame += 1000/exportFps;
      if(nextFrame < now-(1000/exportFps)) nextFrame=now;
    }

    const delay=Math.max(0,Math.min(8,nextFrame-performance.now()));
    await new Promise(r=>setTimeout(r,delay));
  }

  state.currentTime=duration;
  renderPreview();
  octx.drawImage(els.canvas,0,0,out.width,out.height);
  await new Promise(r=>setTimeout(r,120)); rec.stop();
  await new Promise(resolve=>rec.onstop=resolve);
  state.isExporting=false;
  pausePreviewPlayback();
  for(const item of preparedVideos){
    try{item.el.pause();}catch{}
  }
  state.exportRenderLongSide=oldExportLongSide;
  if(audioSource){try{audioSource.stop()}catch{}} if(audioCtx){try{await audioCtx.close()}catch{}}
  const blob=new Blob(chunks,{type:"video/webm"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`${state.project.name.replace(/[^\w-]+/g,"_")||"pocketcut"}.webm`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1500);
  state.currentTime=oldTime; if(oldPlaying)play(); else renderAll();
  status.textContent=audioMix.skipped.length?`Export complete. Audio could not be decoded from: ${audioMix.skipped.join(", ")}.`:`Export complete with mixed audio.`;
}



function startPreviewPositionDrag(e){
  if(state.isPlaying) return;
  const sel=selectedClip();
  if(!sel || !["video","image","text","subtitle"].includes(sel.clip.type)) return;
  const c=sel.clip;
  if(state.currentTime<c.start || state.currentTime>c.start+c.duration) state.currentTime=c.start;

  const rect=els.canvas.getBoundingClientRect();
  if(!rect.width || !rect.height) return;
  e.preventDefault();
  commitHistory();
  els.previewStage?.classList.add("dragging-position");

  const setPosition=(ev)=>{
    const x=clamp((ev.clientX-rect.left)/rect.width,0,1);
    const y=clamp((ev.clientY-rect.top)/rect.height,0,1);
    if(["video","image"].includes(c.type) && (c.keyframes||[]).length){
      upsertKeyframe(c,state.currentTime-c.start,{x,y});
    }else{
      c.x=x; c.y=y;
    }
    renderPreview();
    renderInspector();
  };

  setPosition(e);
  const move=(ev)=>setPosition(ev);
  const up=()=>{
    els.previewStage?.classList.remove("dragging-position");
    window.removeEventListener("pointermove",move);
    window.removeEventListener("pointerup",up);
    renderAll();
  };
  window.addEventListener("pointermove",move);
  window.addEventListener("pointerup",up);
}

function fullscreenElement(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function syncFullscreenButton(){
  const active = fullscreenElement()===els.previewPanel || els.previewPanel?.classList.contains("fallback-fullscreen");
  if(els.fullscreenBtn){
    els.fullscreenBtn.textContent = active ? "⛶ Exit fullscreen" : "⛶ Fullscreen";
    els.fullscreenBtn.setAttribute("aria-label", active ? "Exit fullscreen preview" : "Enter fullscreen preview");
  }
}
async function toggleFullscreen(){
  if(!els.previewPanel) return;
  const active = fullscreenElement()===els.previewPanel;
  if(active){
    if(document.exitFullscreen) await document.exitFullscreen();
    else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
    syncFullscreenButton();
    return;
  }
  if(els.previewPanel.classList.contains("fallback-fullscreen")){
    els.previewPanel.classList.remove("fallback-fullscreen");
    document.body.classList.remove("preview-fallback-fullscreen");
    syncFullscreenButton();
    return;
  }
  try{
    if(els.previewPanel.requestFullscreen){
      await els.previewPanel.requestFullscreen();
    }else if(els.previewPanel.webkitRequestFullscreen){
      els.previewPanel.webkitRequestFullscreen();
    }else{
      els.previewPanel.classList.add("fallback-fullscreen");
      document.body.classList.add("preview-fallback-fullscreen");
    }
  }catch{
    els.previewPanel.classList.add("fallback-fullscreen");
    document.body.classList.add("preview-fallback-fullscreen");
  }
  syncFullscreenButton();
}


function installDurationStyles(){
  if(document.getElementById("pc-duration-styles")) return;
  const style=document.createElement("style");
  style.id="pc-duration-styles";
  style.textContent=`
    .clip-resize-handle{
      position:absolute;
      top:0;
      right:0;
      width:14px;
      height:100%;
      cursor:ew-resize;
      touch-action:none;
      z-index:9;
    }
    .clip-resize-handle::after{
      content:"";
      position:absolute;
      right:3px;
      top:8px;
      bottom:8px;
      width:3px;
      border-radius:3px;
      background:rgba(255,255,255,.78);
    }
    .duration-tools{
      grid-column:1/-1;
      display:flex;
      gap:7px;
      flex-wrap:wrap;
    }
    .duration-tools button{
      min-width:64px;
    }
    @media(max-width:640px){
      .clip-resize-handle{width:20px}
      .clip-resize-handle::after{right:5px;width:4px}
    }
  `;
  document.head.appendChild(style);
}


function installMediaDragStyles(){
  if(document.getElementById("pc-media-drag-styles")) return;
  const style=document.createElement("style");
  style.id="pc-media-drag-styles";
  style.textContent=`
    .media-card[draggable="true"]{cursor:grab}
    .media-card.dragging-media{opacity:.55;cursor:grabbing}
    .track-row.media-drop-target{
      background:rgba(124,156,255,.14)!important;
      box-shadow:inset 0 0 0 2px rgba(124,156,255,.55);
    }
  `;
  document.head.appendChild(style);
}


function installTextOverlayControls(){
  if(document.getElementById("addTextBtn")) return;
  const subtitleBtn=document.getElementById("addSubtitleBtn");
  if(!subtitleBtn) return;
  const btn=document.createElement("button");
  btn.id="addTextBtn";
  btn.type="button";
  btn.textContent="Text";
  btn.title="Add a separate text box";
  subtitleBtn.insertAdjacentElement("afterend",btn);

  const style=document.createElement("style");
  style.id="pc-text-overlay-styles";
  style.textContent=`
    .clip.text{background:linear-gradient(135deg,#446274,#293e4a)}
    .clip.subtitle{background:linear-gradient(135deg,#7a5c2e,#4d391f)}
  `;
  document.head.appendChild(style);
}


function showPocketCutError(message){
  console.error("[PocketCut]",message);
  let bar=document.getElementById("pc-runtime-error");
  if(!bar){
    bar=document.createElement("div");
    bar.id="pc-runtime-error";
    Object.assign(bar.style,{
      position:"fixed",left:"10px",right:"10px",bottom:"10px",zIndex:"99999",
      padding:"10px 12px",borderRadius:"8px",background:"#5b1d1d",color:"#fff",
      font:"14px/1.35 system-ui,sans-serif",boxShadow:"0 4px 18px rgba(0,0,0,.35)"
    });
    document.body.appendChild(bar);
  }
  bar.textContent="PocketCut recovered from an error: "+String(message||"Unknown error");
}

function normalizeProjectState(){
  if(!state.project || typeof state.project!=="object") state.project={};
  if(!Array.isArray(state.project.tracks)) state.project.tracks=[];
  state.project.name=state.project.name||"Untitled project";
  state.project.aspect=state.project.aspect||"16:9";
  state.project.backupInterval=Number.isFinite(Number(state.project.backupInterval))?Number(state.project.backupInterval):15;

  const validTypes=new Set(["video","overlay","audio","subtitle","text"]);
  state.project.tracks=state.project.tracks.filter(t=>t && typeof t==="object");
  for(const t of state.project.tracks){
    if(!t.id) t.id=uid();
    if(!validTypes.has(t.type)) t.type="video";
    if(!Array.isArray(t.clips)) t.clips=[];
    if(!t.name) t.name=t.type==="audio"?"Audio":t.type==="subtitle"?"Subtitles":t.type==="text"?"Text":"Video";
    t.clips=t.clips.filter(c=>c && typeof c==="object");
    for(const c of t.clips){
      if(!c.id) c.id=uid();
      c.start=Math.max(0,Number(c.start)||0);
      c.duration=Math.max(.05,Number(c.duration)||5);
      if(c.type==="video" || c.type==="audio"){
        c.speed=clamp(Number(c.speed)||1,.25,100);
      }
      if(c.type==="image" || c.type==="video"){
        c.opacity=Number.isFinite(Number(c.opacity))?Number(c.opacity):1;
        c.scale=Number.isFinite(Number(c.scale))?Number(c.scale):1;
        c.x=Number.isFinite(Number(c.x))?Number(c.x):.5;
        c.y=Number.isFinite(Number(c.y))?Number(c.y):.5;
        c.rotation=Number(c.rotation)||0;
      }
      if(c.type==="subtitle" || c.type==="text"){
        c.text=String(c.text??(c.type==="text"?"Text":""));
        c.fontScale=Number.isFinite(Number(c.fontScale))?Number(c.fontScale):(c.type==="text"?.06:.045);
        c.textWidth=Number.isFinite(Number(c.textWidth))?Number(c.textWidth):(c.type==="text"?.55:.86);
        c.x=Number.isFinite(Number(c.x))?Number(c.x):.5;
        c.y=Number.isFinite(Number(c.y))?Number(c.y):(c.type==="text"?.5:.90);
        c.color=c.color||"#ffffff";
        c.bgColor=c.bgColor||"#000000";
        c.bgOpacity=clamp(Number(c.bgOpacity)||0,0,1);
      }
    }
  }

  if(!state.project.tracks.some(t=>t.type==="video")){
    state.project.tracks.unshift({id:uid(),type:"video",name:"Video 1",clips:[]});
  }
  if(!state.project.tracks.some(t=>t.type==="audio")){
    state.project.tracks.push({id:uid(),type:"audio",name:"Audio 1",clips:[]});
  }
  if(!state.project.tracks.some(t=>t.type==="subtitle")){
    state.project.tracks.push({id:uid(),type:"subtitle",name:"Subtitles",clips:[]});
  }
}

function bindSafe(el,event,handler){
  if(!el) return false;
  try{
    if(event==="click") el.onclick=handler;
    else if(event==="change") el.onchange=handler;
    else if(event==="input") el.oninput=handler;
    else el.addEventListener(event,handler);
    return true;
  }catch(err){
    console.warn("Could not bind control",el?.id,event,err);
    return false;
  }
}
function bindId(id,event,handler){ return bindSafe(document.getElementById(id),event,handler); }

function bind(){
  bindSafe(els.fileInput,"change",e=>importFiles([...(e.target.files||[])]));
  if(els.dropZone){
    ["dragenter","dragover"].forEach(ev=>els.dropZone.addEventListener(ev,e=>{
      e.preventDefault(); els.dropZone.classList.add("drag");
    }));
    ["dragleave","drop"].forEach(ev=>els.dropZone.addEventListener(ev,e=>{
      e.preventDefault(); els.dropZone.classList.remove("drag");
    }));
    els.dropZone.addEventListener("drop",e=>importFiles([...(e.dataTransfer?.files||[])]));
  }

  bindSafe(els.playBtn,"click",togglePlay);
  bindSafe(els.previewPlayBtn,"click",togglePlay);
  bindSafe(els.canvas,"click",()=>{if(state.isPlaying) togglePlay();});
  els.canvas?.addEventListener("pointerdown",startPreviewPositionDrag);

  bindId("rewindBtn","click",()=>seekBy(-5));
  bindId("forwardBtn","click",()=>seekBy(5));
  bindId("splitBtn","click",splitSelected);
  bindId("duplicateBtn","click",duplicateSelected);
  bindId("deleteBtn","click",deleteSelected);
  bindId("detachAudioBtn","click",detachAudio);
  bindId("reverseBtn","click",reverseSelected);
  bindId("addSubtitleBtn","click",addSubtitle);
  bindId("addTextBtn","click",addTextOverlay);
  bindId("addVideoTrackBtn","click",()=>addTrack("video"));
  bindId("addAudioTrackBtn","click",()=>addTrack("audio"));
  bindId("undoBtn","click",undo);
  bindId("redoBtn","click",redo);

  bindSafe(els.zoom,"input",()=>{
    state.pixelsPerSecond=Number(els.zoom.value)||90;
    renderRuler(); renderTracks();
  });
  bindSafe(els.fullscreenBtn,"click",toggleFullscreen);

  document.addEventListener("fullscreenchange",syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange",syncFullscreenButton);

  bindId("saveSubtitleBtn","click",e=>{e.preventDefault();saveSubtitle();});
  bindId("backupBtn","click",()=>{renderBackupList();els.backupDialog?.showModal?.();});
  bindId("closeBackupDialog","click",()=>els.backupDialog?.close?.());
  bindId("createBackupNow","click",async()=>{await createBackup("manual");renderBackupList();});
  bindId("downloadProjectBtn","click",downloadJSON);
  bindId("projectFileInput","change",e=>e.target.files?.[0]&&importProjectFile(e.target.files[0]));
  bindId("settingsBtn","click",()=>{syncSettingsUI();els.settingsDialog?.showModal?.();});
  bindId("closeSettingsDialog","click",()=>els.settingsDialog?.close?.());
  bindId("saveSettingsBtn","click",saveSettings);
  bindId("backupIntervalSelect","change",updateBackupWindowText);
  bindId("exportBtn","click",()=>els.exportDialog?.showModal?.());
  bindId("closeExportDialog","click",()=>els.exportDialog?.close?.());
  bindId("startExportBtn","click",exportWebM);

  window.addEventListener("keydown",(e)=>{
    if(["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) return;
    if(e.code==="Space"){e.preventDefault();togglePlay();}
    if(e.key==="Escape" && els.previewPanel?.classList.contains("fallback-fullscreen")){
      els.previewPanel.classList.remove("fallback-fullscreen");
      document.body.classList.remove("preview-fallback-fullscreen");
      syncFullscreenButton();
    }
    if(e.key==="Delete"||e.key==="Backspace") deleteSelected();
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){
      e.preventDefault(); e.shiftKey?redo():undo();
    }
  });

  window.addEventListener("resize",()=>{try{renderPreview();}catch(err){console.warn(err);}});
  window.addEventListener("beforeunload",()=>{try{createBackup("auto");}catch{}});
}

async function init(){
  try{installDurationStyles();}catch(err){console.warn(err);}
  try{installMediaDragStyles();}catch(err){console.warn(err);}
  try{installTextOverlayControls();}catch(err){console.warn(err);}
  try{bind();}catch(err){showPocketCutError(err?.message||err);}

  // Make the interface usable immediately, even if IndexedDB/backups fail.
  try{
    normalizeProjectState();
    syncSettingsUI();
    renderAll();
  }catch(err){
    showPocketCutError(err?.message||err);
  }

  try{
    await restoreLatestSession();
    normalizeProjectState();
    syncSettingsUI();
    renderAll();
  }catch(err){
    console.warn("Saved session could not be restored; starting with current project.",err);
    showPocketCutError("A saved local session could not be restored. The editor is still usable.");
  }

  try{scheduleAutosave();}catch(err){console.warn(err);}

  setInterval(()=>{
    if(state.isPlaying || state.isExporting) return;
    try{renderPreview();}catch(err){console.warn("Preview refresh failed",err);}
  },250);
}

window.addEventListener("error",e=>{
  if(e?.error) showPocketCutError(e.error.message||e.message);
});
window.addEventListener("unhandledrejection",e=>{
  const msg=e?.reason?.message||String(e?.reason||"");
  if(msg && !/play\(\)|user gesture|interact/i.test(msg)) console.warn("Unhandled PocketCut promise",e.reason);
});

init().catch(err=>showPocketCutError(err?.message||err));
})();
