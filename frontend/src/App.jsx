import { useState, useEffect, useRef, useCallback } from "react";

/* ───────────────────────────────────────────────────────────────
   CONSTANTS
─────────────────────────────────────────────────────────────── */
const EQUIPMENT_OPTIONS = [
  "Barbell","Dumbbells","Kettlebells","Pull-up Bar","Resistance Bands",
  "Cables / Cable Machine","Squat Rack","Bench","Plyo Box",
  "Rower","Assault Bike","Ski Erg","Treadmill","Medicine Ball",
  "TRX / Suspension","Sled / Prowler","Sandbag","Bodyweight Only",
];

const LEVEL_META = {
  low:    { label:"Beginner",     short:"BGN", accent:"#6ee7b7", glow:"rgba(110,231,183,0.12)" },
  medium: { label:"Intermediate", short:"INT", accent:"#fcd34d", glow:"rgba(252,211,77,0.12)"  },
  high:   { label:"Advanced",     short:"ADV", accent:"#fda4af", glow:"rgba(253,164,175,0.12)" },
};

const TODAY_KEY = () => new Date().toISOString().slice(0,10);

const KEYS = {
  clients:     "sc4_clients",
  programs:    "sc4_programs",
  style:       "sc4_style",
  history:     "sc4_history",
  today:       "sc4_today",
  calSettings: "sc4_cal_settings",
};

const DEFAULT_CAL_SETTINGS = {
  google: { enabled:false, icalUrl:"", format:"name_dash", customPattern:"", keyword:"" },
  apple:  { enabled:false, icalUrl:"", format:"name_dash", customPattern:"", keyword:"" },
};

const FORMAT_OPTIONS = [
  { id:"name_dash",   label:"Name — Training",   example:"John Smith - Training",   desc:"Client name BEFORE a dash/separator" },
  { id:"name_only",   label:"Name only",          example:"John Smith",              desc:"Entire event title is the client name" },
  { id:"keyword",     label:"Keyword + Name",     example:"PT: John Smith",          desc:"Name comes AFTER a keyword + separator" },
  { id:"name_first",  label:"Name (anything)",    example:"John Smith @ Gym",        desc:"Client name is always the first word(s)" },
  { id:"custom",      label:"Custom pattern",     example:"",                        desc:"Describe your own format in plain English" },
];

/* ───────────────────────────────────────────────────────────────
   STORAGE  — reads/writes via Flask /api/storage/:key
─────────────────────────────────────────────────────────────── */
async function sGet(key, fallback) {
  try {
    const r = await fetch(`/api/storage/${key}`);
    if (!r.ok) return fallback;
    const d = await r.json();
    return d.value !== undefined && d.value !== null ? d.value : fallback;
  } catch { return fallback; }
}

async function sSet(key, val) {
  try {
    await fetch(`/api/storage/${key}`, {
      method:"PUT",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ value: val }),
    });
  } catch {}
}

/* ───────────────────────────────────────────────────────────────
   CLAUDE API  — proxied through Flask /api/claude
─────────────────────────────────────────────────────────────── */
async function claude(messages, system = "") {
  const body = { messages };
  if (system) body.system = system;
  const r = await fetch("/api/claude", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
const getText = d => (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");

function fileToB64(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* ───────────────────────────────────────────────────────────────
   CLIENT NAME PARSING
─────────────────────────────────────────────────────────────── */
function parseClientName(title="", format="name_dash", customPattern="", keyword="") {
  const t = title.trim();
  switch(format) {
    case "name_dash": { const m=t.match(/^(.+?)\s*[-–—|/]\s*.+$/); return m?m[1].trim():t; }
    case "name_only":  return t;
    case "keyword": {
      const kw = keyword||"PT|Training|Session|Workout|S&C|Strength";
      const re = new RegExp(`(?:${kw})\\s*[:\\-–—]?\\s*(.+)`,"i");
      const m = t.match(re); if(m) return m[1].trim();
      const m2 = t.match(/^(.+?)\s*(?:[-–—|]|\s)\s*(?:training|session|workout|pt|s&c|strength|conditioning)/i);
      return m2?m2[1].trim():t;
    }
    case "name_first": {
      const m = t.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?(?:\s[A-Z][a-z]+)?)/);
      return m?m[1].trim():t.split(/[-–—@|]/)[0].trim();
    }
    case "custom": return t;
    default: return t;
  }
}

/* ───────────────────────────────────────────────────────────────
   SECTION PARSER
─────────────────────────────────────────────────────────────── */
function parseSections(text="") {
  const sections=[]; const lines=text.split("\n"); let current=null;
  for(const line of lines) {
    const h=line.match(/^━+\s*(.+?)\s*━+$/)||line.match(/^#{1,3}\s+(.+)$/);
    if(h) { if(current)sections.push(current); current={title:h[1],lines:[]}; }
    else if(current) { if(line.trim())current.lines.push(line); }
    else if(line.trim()) {
      if(!sections.length)sections.push({title:"Overview",lines:[line]});
      else sections[sections.length-1].lines.push(line);
    }
  }
  if(current)sections.push(current);
  return sections.length?sections:[{title:"Workout",lines:text.split("\n").filter(l=>l.trim())}];
}

/* ═══════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════ */
export default function App() {
  const [view,setView]             = useState("daily");
  const [clients,setClients]       = useState([]);
  const [programs,setPrograms]     = useState([]);
  const [coachStyle,setCoachStyle] = useState("");
  const [history,setHistory]       = useState({});
  const [todayData,setTodayData]   = useState(null);
  const [calSettings,setCalSettings] = useState(DEFAULT_CAL_SETTINGS);
  const [ready,setReady]           = useState(false);
  const [notif,setNotif]           = useState(null);

  useEffect(()=>{
    (async()=>{
      const [c,p,s,h,t,cs] = await Promise.all([
        sGet(KEYS.clients,[]), sGet(KEYS.programs,[]), sGet(KEYS.style,""),
        sGet(KEYS.history,{}), sGet(KEYS.today,null),
        sGet(KEYS.calSettings,DEFAULT_CAL_SETTINGS),
      ]);
      setClients(c); setPrograms(p); setCoachStyle(s); setHistory(h);
      setCalSettings({...DEFAULT_CAL_SETTINGS,...cs});
      const todayKey=TODAY_KEY();
      if(t && t.date!==todayKey && t.workouts && Object.keys(t.workouts).length) {
        const newH={...h};
        for(const [name,workout] of Object.entries(t.workouts)) {
          if(!newH[name])newH[name]=[];
          newH[name]=[{date:t.date,workout},...newH[name]].slice(0,90);
        }
        await sSet(KEYS.history,newH); setHistory(newH);
        const fresh={date:todayKey,sessions:[],workouts:{}};
        await sSet(KEYS.today,fresh); setTodayData(fresh);
      } else {
        const td=t&&t.date===todayKey?t:{date:todayKey,sessions:[],workouts:{}};
        setTodayData(td);
      }
      setReady(true);
    })();
  },[]);

  const saveToday      = useCallback(async td  =>{ setTodayData(td);    await sSet(KEYS.today,td);          },[]);
  const saveClients    = useCallback(async c   =>{ setClients(c);       await sSet(KEYS.clients,c);         },[]);
  const savePrograms   = useCallback(async p   =>{ setPrograms(p);      await sSet(KEYS.programs,p);        },[]);
  const saveStyle      = useCallback(async s   =>{ setCoachStyle(s);    await sSet(KEYS.style,s);           },[]);
  const saveCalSettings= useCallback(async cs  =>{ setCalSettings(cs);  await sSet(KEYS.calSettings,cs);    },[]);
  const notify = (msg,type="ok")=>{ setNotif({msg,type}); setTimeout(()=>setNotif(null),3500); };

  if(!ready) return (
    <div style={{minHeight:"100vh",background:"#0a0d12",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#374151",fontFamily:"'DM Mono',monospace",fontSize:13,letterSpacing:"0.12em"}}>LOADING…</div>
    </div>
  );

  return (
    <Shell view={view} setView={setView} clientCount={clients.length} programCount={programs.length} notif={notif}>
      {view==="daily"   && <DailyView   clients={clients} programs={programs} coachStyle={coachStyle} history={history} todayData={todayData} saveToday={saveToday} calSettings={calSettings} notify={notify} setView={setView}/>}
      {view==="manage"  && <ManageView  clients={clients} saveClients={saveClients} notify={notify}/>}
      {view==="library" && <LibraryView programs={programs} savePrograms={savePrograms} coachStyle={coachStyle} saveStyle={saveStyle} notify={notify}/>}
      {view==="history" && <HistoryView clients={clients} history={history}/>}
      {view==="settings"&& <CalendarSettings calSettings={calSettings} saveCalSettings={saveCalSettings} notify={notify}/>}
    </Shell>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SHELL
═══════════════════════════════════════════════════════════════ */
function Shell({view,setView,clientCount,programCount,notif,children}) {
  const NAV=[
    {id:"daily",    label:"Today",    icon:"◉"},
    {id:"manage",   label:"Clients",  icon:"◈"},
    {id:"library",  label:"Library",  icon:"⊞"},
    {id:"history",  label:"History",  icon:"⊙"},
    {id:"settings", label:"Calendars",icon:"⟳"},
  ];
  return (
    <div style={{minHeight:"100vh",background:"#0a0d12",fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&display=swap'); *{box-sizing:border-box;margin:0;padding:0;} ::-webkit-scrollbar{width:3px;height:3px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:#1e2530;border-radius:4px} input,textarea,select{outline:none;font-family:'DM Sans',sans-serif;} @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}} @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}} @keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}} .card-enter{animation:fadeUp 0.45s cubic-bezier(0.16,1,0.3,1) both;} .card-enter:nth-child(1){animation-delay:0.04s} .card-enter:nth-child(2){animation-delay:0.09s} .card-enter:nth-child(3){animation-delay:0.14s} .navbtn:hover{color:#d1d5db!important;background:rgba(255,255,255,0.04)!important;} .abtn:hover{opacity:0.82;transform:translateY(-1px);} @media print{nav,.no-print{display:none!important;} body{background:white!important;} .print-card{page-break-after:always;}}`}</style>

      {notif&&(
        <div style={{position:"fixed",top:20,right:20,zIndex:9999,padding:"12px 20px",borderRadius:10,fontFamily:"'DM Mono',monospace",fontSize:12,letterSpacing:"0.05em",background:notif.type==="err"?"#1f0a0a":notif.type==="warn"?"#1a1400":"#0a1a0e",border:`1px solid ${notif.type==="err"?"#5b1c1c":notif.type==="warn"?"#5b4a00":"#1a4d2c"}`,color:notif.type==="err"?"#f87171":notif.type==="warn"?"#fbbf24":"#6ee7b7",boxShadow:"0 8px 32px rgba(0,0,0,0.6)"}}>
          {notif.msg}
        </div>
      )}

      <nav style={{position:"sticky",top:0,zIndex:100,background:"rgba(10,13,18,0.9)",backdropFilter:"blur(24px)",borderBottom:"1px solid rgba(255,255,255,0.05)",padding:"0 28px",display:"flex",alignItems:"center",height:54}}>
        <div style={{display:"flex",alignItems:"center",gap:9,paddingRight:24,borderRight:"1px solid rgba(255,255,255,0.06)",marginRight:6}}>
          <div style={{width:26,height:26,background:"linear-gradient(135deg,#f97316,#c2410c)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>⚡</div>
          <span style={{fontFamily:"'DM Serif Display',serif",fontSize:14,color:"#f1f5f9"}}>Coach</span>
        </div>
        {NAV.map(n=>(
          <button key={n.id} className="navbtn" onClick={()=>setView(n.id)} style={{padding:"0 16px",height:54,background:"none",border:"none",cursor:"pointer",borderBottom:view===n.id?"2px solid #f97316":"2px solid transparent",color:view===n.id?"#f97316":"#6b7280",fontSize:12,fontFamily:"'DM Sans',sans-serif",fontWeight:500,transition:"all 0.18s",display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:11,opacity:0.7}}>{n.icon}</span>{n.label}
          </button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",gap:18,fontSize:11,color:"#374151",fontFamily:"'DM Mono',monospace"}}>
          <span><span style={{color:"#6b7280"}}>{clientCount}</span> clients</span>
          <span><span style={{color:"#6b7280"}}>{programCount}</span> programs</span>
        </div>
      </nav>

      <div style={{maxWidth:880,margin:"0 auto",padding:"40px 24px 100px"}}>
        {children}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CALENDAR SETTINGS
═══════════════════════════════════════════════════════════════ */
function CalendarSettings({calSettings,saveCalSettings,notify}) {
  const [local,setLocal]=useState({...DEFAULT_CAL_SETTINGS,...calSettings});
  const [saving,setSaving]=useState(false);
  const update=(cal,field,val)=>setLocal(p=>({...p,[cal]:{...p[cal],[field]:val}}));

  const save=async()=>{ setSaving(true); await saveCalSettings(local); setSaving(false); notify("Calendar settings saved ✓"); };

  return (
    <div>
      <PageHeader title="Calendar Setup" subtitle="Connect your iCal feeds so the app can read today's sessions automatically."/>
      <div style={{display:"flex",flexDirection:"column",gap:20,marginBottom:32}}>
        {[
          {id:"google",icon:"🗓",name:"Google Calendar", color:"#4285f4", howto:"In Google Calendar → Settings → your calendar → Scroll to 'Secret address in iCal format' → Copy that URL."},
          {id:"apple", icon:"🍎",name:"Apple Calendar",  color:"#1c7ed6", howto:"In macOS Calendar → right-click any calendar → Get Info → Copy the URL shown. On iPhone, use iCloud.com → Calendar → share icon → Copy Link."},
        ].map(cal=>{
          const s=local[cal.id]; const isOn=s.enabled;
          return (
            <div key={cal.id} style={{background:"#111827",border:`1px solid ${isOn?"rgba(255,255,255,0.1)":"rgba(255,255,255,0.05)"}`,borderRadius:16,overflow:"hidden"}}>
              <div style={{padding:"20px 24px",display:"flex",alignItems:"center",gap:16,borderBottom:isOn?"1px solid rgba(255,255,255,0.05)":"none"}}>
                <div style={{width:40,height:40,borderRadius:10,background:`${cal.color}18`,border:`1px solid ${cal.color}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{cal.icon}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:600,color:"#f9fafb",marginBottom:3}}>{cal.name}</div>
                  <div style={{fontSize:12,color:"#4b5563",lineHeight:1.5}}>{cal.howto}</div>
                </div>
                <div onClick={()=>update(cal.id,"enabled",!isOn)} style={{width:44,height:24,borderRadius:12,cursor:"pointer",background:isOn?"#f97316":"rgba(255,255,255,0.08)",position:"relative",border:`1px solid ${isOn?"#f97316":"rgba(255,255,255,0.1)"}`,flexShrink:0,transition:"background 0.2s"}}>
                  <div style={{position:"absolute",top:2,left:isOn?22:2,width:18,height:18,borderRadius:9,background:"white",transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}/>
                </div>
              </div>
              {isOn&&(
                <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:16}}>
                  <div>
                    <label style={LBL}>iCal Feed URL</label>
                    <input value={s.icalUrl} onChange={e=>update(cal.id,"icalUrl",e.target.value)} placeholder="webcal://... or https://calendar.google.com/calendar/ical/..." style={{...INP,marginTop:6,fontFamily:"'DM Mono',monospace",fontSize:11}}/>
                  </div>
                  <div>
                    <label style={LBL}>How are your events titled?</label>
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
                      {FORMAT_OPTIONS.map(f=>(
                        <label key={f.id} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"10px 14px",borderRadius:10,cursor:"pointer",border:`1px solid ${s.format===f.id?"rgba(249,115,22,0.4)":"rgba(255,255,255,0.06)"}`,background:s.format===f.id?"rgba(249,115,22,0.06)":"transparent"}}>
                          <div style={{width:16,height:16,borderRadius:8,marginTop:1,flexShrink:0,border:`2px solid ${s.format===f.id?"#f97316":"#374151"}`,background:s.format===f.id?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>update(cal.id,"format",f.id)}>
                            {s.format===f.id&&<div style={{width:6,height:6,borderRadius:3,background:"white"}}/>}
                          </div>
                          <div style={{flex:1}} onClick={()=>update(cal.id,"format",f.id)}>
                            <div style={{fontSize:13,fontWeight:500,color:s.format===f.id?"#f9fafb":"#9ca3af",marginBottom:2}}>{f.label}</div>
                            <div style={{fontSize:11,color:"#374151"}}>{f.desc}</div>
                            {f.example&&<div style={{marginTop:4,fontFamily:"'DM Mono',monospace",fontSize:11,color:"#4b5563",padding:"3px 8px",background:"rgba(255,255,255,0.03)",borderRadius:4,display:"inline-block"}}>{f.example}</div>}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                  {s.format==="keyword"&&(
                    <div>
                      <label style={LBL}>Keyword before the client name</label>
                      <input value={s.keyword} onChange={e=>update(cal.id,"keyword",e.target.value)} placeholder="e.g. PT, Training, Session" style={{...INP,marginTop:6}}/>
                    </div>
                  )}
                  {s.format==="custom"&&(
                    <div>
                      <label style={LBL}>Describe your event format</label>
                      <textarea value={s.customPattern} onChange={e=>update(cal.id,"customPattern",e.target.value)} rows={3} placeholder="e.g. Events look like '7am John / Strength' — name is between '7am' and '/'" style={{...INP,resize:"vertical",marginTop:6,lineHeight:1.6}}/>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ActionBtn onClick={save} loading={saving}>{saving?"Saving…":"Save Settings"}</ActionBtn>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DAILY VIEW
═══════════════════════════════════════════════════════════════ */
function DailyView({clients,programs,coachStyle,history,todayData,saveToday,calSettings,notify,setView}) {
  const [syncing,setSyncing]     = useState({google:false,apple:false});
  const [generating,setGenerating] = useState({});
  const [sharePopup,setSharePopup] = useState(null);

  const sessions = todayData?.sessions||[];
  const workouts = todayData?.workouts||{};

  const matchClient = name =>
    clients.find(c=>c.name.toLowerCase()===name?.toLowerCase())||
    clients.find(c=>name?.toLowerCase()?.includes(c.name.toLowerCase()))||
    clients.find(c=>c.name.toLowerCase().includes(name?.toLowerCase()||""));

  const syncCal = async (calType) => {
    const s = calSettings[calType];
    if(!s?.enabled||!s?.icalUrl) return;
    setSyncing(p=>({...p,[calType]:true}));
    try {
      const params = new URLSearchParams({url:s.icalUrl,format:s.format,keyword:s.keyword||""});
      const r = await fetch(`/api/ical?${params}`);
      const events = await r.json();
      if(!Array.isArray(events)) throw new Error(events.error||"Bad response");
      const parsed = events.map(e=>({
        clientName: parseClientName(e.rawTitle,s.format,s.customPattern,s.keyword),
        time: e.time, rawTitle: e.rawTitle, source: calType,
      })).filter(e=>e.clientName);
      if(parsed.length) {
        const existing = sessions.map(s=>s.clientName);
        const newSessions = parsed.filter(p=>!existing.includes(p.clientName));
        await saveToday({...todayData,sessions:[...sessions,...newSessions]});
        notify(`${parsed.length} session${parsed.length>1?"s":""} loaded from ${calType==="apple"?"Apple":"Google"} Calendar`);
      } else {
        notify(`No training sessions found in ${calType==="apple"?"Apple":"Google"} Calendar today`,"warn");
      }
    } catch(e) { notify(`Sync failed — ${e.message}`,"err"); }
    setSyncing(p=>({...p,[calType]:false}));
  };

  const syncAll = ()=>{ if(calSettings.google.enabled)syncCal("google"); if(calSettings.apple.enabled)syncCal("apple"); };

  const generate = async (clientName,note="") => {
    const client = matchClient(clientName);
    const lv = LEVEL_META[client?.level||"medium"];
    const clientHistory = (history[clientName]||[]).slice(0,8);
    const historyBlock = clientHistory.length
      ? `\nPAST WORKOUTS (most recent first — build progressive overload):\n${clientHistory.map(h=>`[${h.date}]:\n${h.workout}`).join("\n\n---\n\n")}`
      : "";
    const programText = programs.map(p=>`=== ${p.name} ===\n${p.content}`).join("\n\n—\n\n");
    const styleBlock  = coachStyle?`\nCOACH STYLE:\n${coachStyle}\n`:"";
    const avoidList   = client?.avoid?.trim()?`\n⛔ NEVER PROGRAM THESE: ${client.avoid}`:"";
    const spaceCtx    = client?.spaceAnalysis?`\nTRAINING SPACE: ${client.spaceAnalysis}`:"";

    const prompt=`Generate a complete S&C workout.
${styleBlock}${programText?`REFERENCE PROGRAMS:\n${programText}`:""}${historyBlock}

CLIENT:
- Name: ${clientName}
- Level: ${lv.label} (${client?.level==="low"?"technique focus, lower volume":client?.level==="high"?"high intensity, complex movements":"moderate volume"})
- Equipment: ${client?.equipment?.join(", ")||"standard gym"}
- Notes: ${client?.notes||"none"}${avoidList}${spaceCtx}${note?`\nTODAY'S NOTE: ${note}`:""}

Use EXACTLY these section headers:
━━━ WARM-UP (10 min) ━━━
━━━ MAIN WORK ━━━
━━━ ACCESSORY ━━━
━━━ CONDITIONING ━━━
━━━ COOLDOWN ━━━
COACH NOTES:

Every exercise: name, sets×reps, load/intensity, rest. Sound like a real coach.`;

    const msgs = client?.spaceImages?.length
      ? [{role:"user",content:[...client.spaceImages.map(img=>({type:"image",source:{type:"base64",media_type:img.mediaType,data:img.data}})),{type:"text",text:prompt}]}]
      : [{role:"user",content:prompt}];

    setGenerating(p=>({...p,[clientName]:true}));
    try {
      const data = await claude(msgs);
      const workout = getText(data);
      await saveToday({...todayData,workouts:{...workouts,[clientName]:workout}});
    } catch { notify("Generation failed","err"); }
    setGenerating(p=>({...p,[clientName]:false}));
  };

  const generateAll = ()=>sessions.forEach(s=>{ if(!workouts[s.clientName])generate(s.clientName); });

  const shareCard = async (clientName) => {
    const text=`${clientName} — ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}\n\n${workouts[clientName]}`;
    try { await navigator.clipboard.writeText(text); setSharePopup(clientName); setTimeout(()=>setSharePopup(null),2000); } catch {}
  };

  const today=new Date();
  const hasWorkouts=sessions.filter(s=>workouts[s.clientName]).length;
  const anyEnabled=calSettings.google?.enabled||calSettings.apple?.enabled;
  const bothEnabled=calSettings.google?.enabled&&calSettings.apple?.enabled;
  const isSyncing=syncing.google||syncing.apple;

  return (
    <div>
      <div style={{marginBottom:44}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:16}}>
          <div>
            <p style={{fontSize:11,color:"#374151",letterSpacing:"0.14em",fontFamily:"'DM Mono',monospace",marginBottom:10}}>
              {today.toLocaleDateString("en-US",{weekday:"long"}).toUpperCase()} · {today.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}).toUpperCase()}
            </p>
            <h1 style={{fontFamily:"'DM Serif Display',serif",fontSize:40,fontWeight:400,color:"#f9fafb",lineHeight:1.1,letterSpacing:"-0.01em"}}>
              Daily<br/><span style={{color:"#f97316",fontStyle:"italic"}}>Programming</span>
            </h1>
            <p style={{marginTop:12,color:"#6b7280",fontSize:14,lineHeight:1.6,maxWidth:440}}>
              {sessions.length===0?"Sync your calendar or add clients below to build today's sessions.":hasWorkouts===0?`${sessions.length} session${sessions.length>1?"s":""} loaded — generate workouts below.`:`${hasWorkouts} of ${sessions.length} workout${sessions.length>1?"s":""} generated.`}
            </p>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10,alignItems:"flex-end"}}>
            {!anyEnabled?(
              <div style={{padding:"12px 16px",background:"rgba(249,115,22,0.06)",border:"1px solid rgba(249,115,22,0.2)",borderRadius:10,maxWidth:260}}>
                <p style={{fontSize:12,color:"#fb923c",lineHeight:1.5,marginBottom:8}}>No calendars connected yet.</p>
                <ActionBtn small onClick={()=>setView("settings")}>→ Set Up Calendars</ActionBtn>
              </div>
            ):(
              <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
                {bothEnabled?(
                  <ActionBtn onClick={syncAll} loading={isSyncing} secondary>{isSyncing?"Syncing…":"⟳  Sync Both"}</ActionBtn>
                ):(
                  <>
                    {calSettings.google?.enabled&&<ActionBtn onClick={()=>syncCal("google")} loading={syncing.google} secondary>{syncing.google?"Syncing…":"🗓  Sync Google"}</ActionBtn>}
                    {calSettings.apple?.enabled &&<ActionBtn onClick={()=>syncCal("apple")}  loading={syncing.apple}  secondary>{syncing.apple ?"Syncing…":"🍎  Sync Apple"}</ActionBtn>}
                  </>
                )}
                {sessions.length>0&&hasWorkouts<sessions.length&&<ActionBtn onClick={generateAll}>⚡  Generate All</ActionBtn>}
                {hasWorkouts>0&&<ActionBtn onClick={()=>window.print()} secondary small>⊟  Print</ActionBtn>}
              </div>
            )}
          </div>
        </div>

        {clients.length>0&&(
          <div style={{marginTop:24,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:10,color:"#374151",letterSpacing:"0.1em",fontFamily:"'DM Mono',monospace",flexShrink:0}}>+ ADD</span>
            {clients.map(c=>{
              const already=sessions.find(s=>s.clientName===c.name);
              const lv=LEVEL_META[c.level||"medium"];
              return (
                <button key={c.name} onClick={()=>{ if(!already)saveToday({...todayData,sessions:[...sessions,{clientName:c.name,time:""}]}); }} style={{padding:"6px 14px",borderRadius:100,fontSize:12,fontWeight:500,cursor:already?"default":"pointer",border:`1px solid ${already?lv.accent+"55":lv.accent+"22"}`,background:already?lv.glow:"transparent",color:already?lv.accent:"#6b7280",transition:"all 0.15s",display:"flex",alignItems:"center",gap:6}}>
                  <span style={{width:5,height:5,borderRadius:"50%",background:already?lv.accent:"#374151",display:"inline-block",flexShrink:0}}/>
                  {c.name}{already?" ✓":""}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {sessions.length===0?(
        <EmptySlate icon="◉" title="No sessions today" body={clients.length===0?"Go to Clients to add your roster first, then sync your calendar.":"Sync your calendar above or use + ADD to add sessions manually."}/>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:28}}>
          {sessions.map((s,i)=>{
            const client=matchClient(s.clientName);
            const lv=LEVEL_META[client?.level||"medium"];
            const workout=workouts[s.clientName];
            const isGen=generating[s.clientName];
            const pastCount=(history[s.clientName]||[]).length;
            const sections=workout?parseSections(workout):[];
            return (
              <div key={i} className="card-enter print-card" style={{background:"linear-gradient(150deg,#111827 0%,#0d1117 100%)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:20,overflow:"hidden",boxShadow:"0 2px 0 rgba(255,255,255,0.04) inset,0 20px 60px rgba(0,0,0,0.35)"}}>
                <div style={{height:2,background:`linear-gradient(90deg,${lv.accent},${lv.accent}55,transparent)`}}/>
                <div style={{padding:"26px 28px 22px",display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,letterSpacing:"0.14em",padding:"3px 9px",borderRadius:100,background:lv.glow,border:`1px solid ${lv.accent}44`,color:lv.accent}}>{lv.short}</span>
                      {s.time&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#374151"}}>{s.time}</span>}
                      {s.source&&<span style={{fontSize:10,color:"#374151"}}>{s.source==="apple"?"🍎 Apple":"🗓 Google"}</span>}
                      {pastCount>0&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#1f2937"}}>↑ {pastCount} prev</span>}
                      {client?.avoid?.trim()&&<span style={{fontSize:10,padding:"2px 8px",borderRadius:100,background:"rgba(127,29,29,0.2)",border:"1px solid rgba(127,29,29,0.3)",color:"#7f1d1d"}}>⛔ avoid list</span>}
                    </div>
                    <h2 style={{fontFamily:"'DM Serif Display',serif",fontSize:30,fontWeight:400,color:"#f9fafb",letterSpacing:"-0.01em",lineHeight:1,marginBottom:8}}>{s.clientName}</h2>
                    {client?.equipment?.length>0&&<p style={{fontSize:12,color:"#374151",lineHeight:1.5}}>{client.equipment.join("  ·  ")}</p>}
                  </div>
                  <div className="no-print" style={{display:"flex",gap:8,flexShrink:0,flexWrap:"wrap",justifyContent:"flex-end"}}>
                    {!workout&&!isGen&&<ActionBtn onClick={()=>generate(s.clientName)}>⚡  Generate</ActionBtn>}
                    {isGen&&<div style={{padding:"10px 16px",borderRadius:10,background:"rgba(249,115,22,0.06)",border:"1px solid rgba(249,115,22,0.15)",color:"#f97316",fontSize:12,fontFamily:"'DM Mono',monospace",display:"flex",alignItems:"center",gap:8}}><span style={{animation:"pulse 1.4s infinite",width:6,height:6,borderRadius:"50%",background:"#f97316",display:"inline-block"}}/>Building…</div>}
                    {workout&&!isGen&&<><ActionBtn onClick={()=>generate(s.clientName)} secondary small>↺ Redo</ActionBtn><ActionBtn onClick={()=>shareCard(s.clientName)} secondary small>{sharePopup===s.clientName?"✓ Copied!":"⎘ Share"}</ActionBtn></>}
                    <button onClick={()=>{ const ns=sessions.filter((_,j)=>j!==i); const nw={...workouts}; delete nw[s.clientName]; saveToday({...todayData,sessions:ns,workouts:nw}); }} style={{width:30,height:30,borderRadius:"50%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",color:"#374151",cursor:"pointer",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                  </div>
                </div>
                {workout&&!isGen&&(
                  <div style={{padding:"0 28px 28px"}}>
                    <div style={{height:1,background:"linear-gradient(90deg,rgba(255,255,255,0.07),transparent)",marginBottom:24}}/>
                    <div style={{display:"flex",flexDirection:"column",gap:0}}>
                      {sections.map((sec,si)=>{
                        const isNotes=sec.title.toLowerCase().includes("coach")||sec.title.toLowerCase().includes("note");
                        return (
                          <div key={si} style={{display:"grid",gridTemplateColumns:"150px 1fr",gap:16,padding:"14px 0",borderBottom:si<sections.length-1?"1px solid rgba(255,255,255,0.035)":"none"}}>
                            <div style={{paddingTop:2}}>
                              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:"0.14em",color:isNotes?lv.accent:"#374151",fontWeight:500}}>{sec.title.replace(/\(.*?\)/,"").trim().toUpperCase()}</div>
                              {sec.title.match(/\((.+?)\)/)&&<div style={{fontSize:10,color:"#1f2937",fontFamily:"'DM Mono',monospace",marginTop:3}}>{sec.title.match(/\((.+?)\)/)[1]}</div>}
                            </div>
                            <div style={{display:"flex",flexDirection:"column",gap:4}}>
                              {sec.lines.map((line,li)=>{
                                if(!line.trim())return null;
                                const isExercise=/sets|reps|×|x\s*\d|@\s*\d|rounds|AMRAP|min\s|:\s*\d/i.test(line);
                                const clean=line.replace(/^\s*[-•–·]\s*/,"").replace(/^\s*[A-Z]\d+\.\s*/,"").trim();
                                if(!clean)return null;
                                return (
                                  <div key={li} style={{display:"flex",alignItems:"baseline",gap:8,padding:isExercise?"8px 10px":"3px 0",background:isExercise?"rgba(255,255,255,0.018)":"transparent",borderRadius:isExercise?7:0,borderLeft:isExercise?`2px solid ${lv.accent}55`:"none",paddingLeft:isExercise?12:0}}>
                                    {isExercise&&<div style={{width:4,height:4,borderRadius:2,background:lv.accent,flexShrink:0,marginTop:2,opacity:0.6}}/>}
                                    <span style={{fontSize:13.5,lineHeight:1.65,color:isNotes?"#6b7280":isExercise?"#e5e7eb":"#9ca3af",fontStyle:isNotes?"italic":"normal",fontWeight:isExercise?400:300}}>{clean}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <RegenRow onRegen={note=>generate(s.clientName,note)} accent={lv.accent}/>
                  </div>
                )}
                {isGen&&(
                  <div style={{padding:"0 28px 28px"}}>
                    <div style={{height:1,background:"rgba(255,255,255,0.05)",marginBottom:24}}/>
                    {[80,100,60,90].map((w,n)=>(
                      <div key={n} style={{display:"grid",gridTemplateColumns:"150px 1fr",gap:16,paddingBottom:18,marginBottom:18,borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                        <div style={{height:9,borderRadius:4,background:"rgba(255,255,255,0.04)",width:"60%"}}/>
                        <div style={{display:"flex",flexDirection:"column",gap:8}}>
                          {[w,w-20,w-10].map((pw,m)=><div key={m} style={{height:10,borderRadius:4,width:`${pw}%`,background:"linear-gradient(90deg,rgba(255,255,255,0.03) 25%,rgba(255,255,255,0.07) 50%,rgba(255,255,255,0.03) 75%)",backgroundSize:"200% 100%",animation:"shimmer 1.8s infinite"}}/>)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RegenRow({onRegen,accent}) {
  const [note,setNote]=useState(""); const [open,setOpen]=useState(false);
  return (
    <div className="no-print" style={{marginTop:22}}>
      {!open&&<button onClick={()=>setOpen(true)} style={{fontSize:12,color:"#374151",background:"none",border:"none",cursor:"pointer",fontFamily:"'DM Sans',sans-serif",padding:0}}>+ Regenerate with instructions</button>}
      {open&&(
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <input value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. posterior chain focus, 40 min cap, no running…" onKeyDown={e=>{ if(e.key==="Enter"){onRegen(note);setOpen(false);setNote("");} }} style={{flex:1,...INP,fontSize:12}}/>
          <ActionBtn small onClick={()=>{onRegen(note);setOpen(false);setNote("");}}>↺ Redo</ActionBtn>
          <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",color:"#374151",cursor:"pointer",fontSize:18}}>×</button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MANAGE CLIENTS
═══════════════════════════════════════════════════════════════ */
function ManageView({clients,saveClients,notify}) {
  const BLANK={name:"",level:"medium",equipment:[],notes:"",avoid:"",spaceImages:[],spaceAnalysis:""};
  const [editIdx,setEditIdx]=useState(null);
  const [form,setForm]=useState({...BLANK});
  const [spaceLoading,setSpaceLoading]=useState(false);
  const spaceRef=useRef();

  const openNew  = ()=>{ setEditIdx(null); setForm({...BLANK}); };
  const openEdit = i=>{ setEditIdx(i); setForm({...BLANK,...clients[i]}); };
  const save=async()=>{
    if(!form.name.trim())return notify("Name required","warn");
    await saveClients(editIdx!==null?clients.map((c,i)=>i===editIdx?{...form}:c):[...clients,{...form}]);
    openNew(); notify("Client saved ✓");
  };
  const del=async i=>{ if(editIdx===i)openNew(); await saveClients(clients.filter((_,j)=>j!==i)); notify("Removed"); };
  const toggleEquip=eq=>setForm(p=>({...p,equipment:p.equipment.includes(eq)?p.equipment.filter(x=>x!==eq):[...p.equipment,eq]}));

  const uploadSpace=async e=>{
    const files=Array.from(e.target.files).filter(f=>f.type.startsWith("image/")); if(!files.length)return;
    setSpaceLoading(true);
    const imgs=await Promise.all(files.map(async f=>({name:f.name,data:await fileToB64(f),mediaType:f.type,preview:URL.createObjectURL(f)})));
    try {
      const data=await claude([{role:"user",content:[...imgs.map(i=>({type:"image",source:{type:"base64",media_type:i.mediaType,data:i.data}})),{type:"text",text:"Analyze this training space. Describe: available equipment (specific), space dimensions/layout, floor type, training modalities possible, and limitations. Concise but thorough."}]}]);
      setForm(p=>({...p,spaceImages:[...(p.spaceImages||[]),...imgs],spaceAnalysis:getText(data)}));
      notify("Space analyzed ✓");
    } catch { setForm(p=>({...p,spaceImages:[...(p.spaceImages||[]),...imgs]})); notify("Upload done, analysis failed","warn"); }
    setSpaceLoading(false); e.target.value="";
  };

  return (
    <div>
      <PageHeader title="Clients" subtitle="All client details are saved permanently and used to build every workout."/>
      <div style={{display:"grid",gridTemplateColumns:"360px 1fr",gap:28,alignItems:"start"}}>
        <div style={{background:"#111827",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,padding:26,position:"sticky",top:74}}>
          <p style={{fontFamily:"'DM Mono',monospace",fontSize:10,letterSpacing:"0.14em",color:"#374151",marginBottom:18,display:"flex",justifyContent:"space-between"}}>
            <span>{editIdx!==null?"EDIT CLIENT":"NEW CLIENT"}</span>
            <span style={{color:"#14532d"}}>● AUTO-SAVED</span>
          </p>
          <FormField label="Name"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Full name" style={INP}/></FormField>
          <FormField label="Fitness Level">
            <div style={{display:"flex",gap:8}}>
              {Object.entries(LEVEL_META).map(([k,v])=>(
                <button key={k} onClick={()=>setForm(p=>({...p,level:k}))} style={{flex:1,padding:"8px 4px",borderRadius:8,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:500,letterSpacing:"0.1em",fontSize:11,border:`1px solid ${form.level===k?v.accent+"66":"rgba(255,255,255,0.06)"}`,background:form.level===k?v.glow:"transparent",color:form.level===k?v.accent:"#4b5563"}}>{v.short}</button>
              ))}
            </div>
          </FormField>
          <FormField label="Equipment">
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {EQUIPMENT_OPTIONS.map(eq=>{ const on=form.equipment.includes(eq); return <button key={eq} onClick={()=>toggleEquip(eq)} style={{padding:"4px 10px",borderRadius:100,fontSize:11,cursor:"pointer",border:`1px solid ${on?"#60a5fa44":"rgba(255,255,255,0.06)"}`,background:on?"rgba(96,165,250,0.07)":"transparent",color:on?"#93c5fd":"#4b5563"}}>{eq}</button>; })}
            </div>
          </FormField>
          <FormField label="Notes / Goals / Injuries">
            <textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} rows={2} placeholder="Goals, injuries, experience…" style={{...INP,resize:"vertical"}}/>
          </FormField>
          <FormField label="⛔ Exercises to Avoid">
            <textarea value={form.avoid} onChange={e=>setForm(p=>({...p,avoid:e.target.value}))} rows={3} placeholder={"Back Squat (knee)\nOverhead Press (shoulder)\nBurpees"} style={{...INP,resize:"vertical",borderColor:"rgba(239,68,68,0.2)",color:"#fca5a5"}}/>
            {form.avoid?.trim()&&<div style={{marginTop:7,display:"flex",flexWrap:"wrap",gap:4}}>{form.avoid.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean).map((x,i)=><span key={i} style={{padding:"3px 9px",borderRadius:100,background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.18)",color:"#f87171",fontSize:11}}>⛔ {x}</span>)}</div>}
          </FormField>
          <FormField label="📍 Training Space Photos">
            <input ref={spaceRef} type="file" accept="image/*" multiple onChange={uploadSpace} style={{display:"none"}}/>
            <ActionBtn secondary small loading={spaceLoading} onClick={()=>spaceRef.current?.click()}>{spaceLoading?"Analyzing…":"Upload Photos"}</ActionBtn>
            {form.spaceImages?.length>0&&<div style={{marginTop:10,display:"flex",gap:8,flexWrap:"wrap"}}>{form.spaceImages.map((img,i)=><div key={i} style={{position:"relative"}}><img src={img.preview} alt="" style={{width:60,height:60,objectFit:"cover",borderRadius:8,border:"1px solid rgba(255,255,255,0.08)"}}/><button onClick={()=>setForm(p=>({...p,spaceImages:p.spaceImages.filter((_,j)=>j!==i)}))} style={{position:"absolute",top:-5,right:-5,width:16,height:16,borderRadius:"50%",background:"#1f0a0a",border:"1px solid #7f1d1d",color:"#f87171",cursor:"pointer",fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>×</button></div>)}</div>}
            {form.spaceAnalysis&&<p style={{marginTop:10,fontSize:11,color:"#7dd3fc",lineHeight:1.6,padding:"10px 12px",background:"rgba(56,189,248,0.04)",border:"1px solid rgba(56,189,248,0.12)",borderRadius:8}}>{form.spaceAnalysis}</p>}
          </FormField>
          <div style={{display:"flex",gap:10}}>
            <ActionBtn onClick={save}>{editIdx!==null?"Save Changes":"Add Client"}</ActionBtn>
            {editIdx!==null&&<ActionBtn secondary onClick={openNew}>Cancel</ActionBtn>}
          </div>
        </div>
        <div>
          <p style={{fontFamily:"'DM Mono',monospace",fontSize:10,letterSpacing:"0.14em",color:"#374151",marginBottom:16}}>ROSTER — {clients.length} CLIENTS</p>
          {clients.length===0?<EmptySlate icon="◈" title="No clients yet" body="Add your first client using the form."/>:(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {clients.map((c,i)=>{ const lv=LEVEL_META[c.level||"medium"]; const avoids=c.avoid?.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean)||[]; return (
                <div key={i} style={{background:"#111827",border:`1px solid ${lv.accent}22`,borderRadius:14,padding:"18px 20px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,flexWrap:"wrap"}}>
                        <h3 style={{fontFamily:"'DM Serif Display',serif",fontSize:19,fontWeight:400,color:"#f9fafb"}}>{c.name}</h3>
                        <span style={{padding:"2px 9px",borderRadius:100,background:lv.glow,border:`1px solid ${lv.accent}44`,color:lv.accent,fontSize:10,fontFamily:"'DM Mono',monospace"}}>{lv.short}</span>
                        {avoids.length>0&&<span style={{fontSize:10,color:"#7f1d1d",fontFamily:"'DM Mono',monospace"}}>⛔ {avoids.length}</span>}
                      </div>
                      {c.equipment?.length>0&&<p style={{fontSize:12,color:"#374151",lineHeight:1.5}}>{c.equipment.join("  ·  ")}</p>}
                      {c.notes&&<p style={{marginTop:5,fontSize:12,color:"#4b5563",fontStyle:"italic",lineHeight:1.5}}>{c.notes}</p>}
                      {avoids.length>0&&<div style={{marginTop:7,display:"flex",flexWrap:"wrap",gap:4}}>{avoids.map((x,j)=><span key={j} style={{padding:"3px 9px",borderRadius:100,background:"rgba(239,68,68,0.06)",border:"1px solid rgba(239,68,68,0.15)",color:"#f87171",fontSize:11}}>⛔ {x}</span>)}</div>}
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <ActionBtn secondary small onClick={()=>openEdit(i)}>Edit</ActionBtn>
                      <button onClick={()=>del(i)} style={{width:30,height:30,borderRadius:"50%",background:"rgba(127,29,29,0.12)",border:"1px solid rgba(127,29,29,0.25)",color:"#f87171",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                    </div>
                  </div>
                </div>
              ); })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LIBRARY
═══════════════════════════════════════════════════════════════ */
function LibraryView({programs,savePrograms,coachStyle,saveStyle,notify}) {
  const [form,setForm]=useState({name:"",content:""});
  const [analyzing,setAnalyzing]=useState(false);
  const fileRef=useRef();

  const add=async()=>{ if(!form.name.trim()||!form.content.trim())return notify("Name & content required","warn"); await savePrograms([...programs,{...form}]); setForm({name:"",content:""}); notify("Added ✓"); };
  const del=async i=>{ await savePrograms(programs.filter((_,j)=>j!==i)); };

  const analyze=async()=>{
    if(!programs.length)return notify("Add programs first","warn");
    setAnalyzing(true);
    const txt=programs.map(p=>`=== ${p.name} ===\n${p.content}`).join("\n\n");
    try {
      const data=await claude([{role:"user",content:`Analyze these S&C programs by one coach. Extract:\n1. Exercise selection patterns\n2. Rep/set schemes & periodization\n3. Conditioning methods\n4. Rest/density preferences\n5. Philosophy & priorities\n6. Unique signatures\n\nBe specific enough to replicate this style.\n\n${txt}`}]);
      await saveStyle(getText(data)); notify("Style learned ✓");
    } catch { notify("Failed","err"); }
    setAnalyzing(false);
  };

  const uploadFile=async e=>{
    const file=e.target.files[0]; if(!file)return;
    const name=file.name.replace(/\.[^.]+$/,"");
    if(file.name.endsWith(".pdf")) {
      const b64=await fileToB64(file);
      try { const data=await claude([{role:"user",content:[{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},{type:"text",text:"Extract the full workout program text. Preserve all structure."}]}]); await savePrograms([...programs,{name,content:getText(data)}]); notify(`"${name}" added ✓`); }
      catch { notify("PDF failed","err"); }
    } else {
      const r=new FileReader(); r.onload=async ev=>{ await savePrograms([...programs,{name,content:ev.target.result}]); notify(`"${name}" added ✓`); }; r.readAsText(file);
    }
    e.target.value="";
  };

  return (
    <div>
      <PageHeader title="Program Library" subtitle="Feed the AI your programs — the more it sees, the better it replicates your coaching style."/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 280px",gap:24,alignItems:"start"}}>
        <div>
          <div style={{background:"#111827",border:"1px solid rgba(255,255,255,0.06)",borderRadius:16,padding:22,marginBottom:16}}>
            <p style={{fontFamily:"'DM Mono',monospace",fontSize:10,letterSpacing:"0.14em",color:"#374151",marginBottom:14}}>PASTE PROGRAM</p>
            <input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Program name" style={{...INP,marginBottom:10}}/>
            <textarea value={form.content} onChange={e=>setForm(p=>({...p,content:e.target.value}))} rows={8} placeholder={"A1. Back Squat  5×5 @ 80%  — 3:00 rest\nA2. Romanian DL  4×8  — 2:00 rest\n\nConditioning: 4 rounds\n  400m Run / 20 KB Swings / 15 Box Jumps"} style={{...INP,resize:"vertical",lineHeight:1.65,fontFamily:"'DM Mono',monospace",fontSize:12}}/>
            <div style={{display:"flex",gap:10,marginTop:12}}>
              <ActionBtn onClick={add}>Add</ActionBtn>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md" onChange={uploadFile} style={{display:"none"}}/>
              <ActionBtn secondary onClick={()=>fileRef.current?.click()}>Upload PDF / TXT</ActionBtn>
            </div>
          </div>
          {programs.length===0?<EmptySlate icon="⊞" title="Library empty" body="Paste or upload programs above."/>:(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {programs.map((p,i)=>(
                <div key={i} style={{background:"#111827",border:"1px solid rgba(255,255,255,0.05)",borderRadius:12,padding:"16px 18px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <h4 style={{fontFamily:"'DM Serif Display',serif",fontSize:17,fontWeight:400,color:"#f9fafb"}}>{p.name}</h4>
                    <button onClick={()=>del(i)} style={{background:"rgba(127,29,29,0.1)",border:"1px solid rgba(127,29,29,0.2)",borderRadius:6,color:"#f87171",cursor:"pointer",fontSize:11,padding:"3px 10px",fontFamily:"'DM Mono',monospace"}}>Remove</button>
                  </div>
                  <pre style={{whiteSpace:"pre-wrap",fontFamily:"'DM Mono',monospace",fontSize:11,lineHeight:1.7,color:"#374151",margin:0,maxHeight:130,overflow:"auto"}}>{p.content}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{position:"sticky",top:74}}>
          <div style={{background:"#111827",border:`1px solid ${coachStyle?"rgba(110,231,183,0.2)":"rgba(255,255,255,0.05)"}`,borderRadius:14,padding:20}}>
            <p style={{fontFamily:"'DM Mono',monospace",fontSize:10,letterSpacing:"0.14em",color:coachStyle?"#6ee7b7":"#374151",marginBottom:12}}>{coachStyle?"◉ STYLE LEARNED":"◎ NO STYLE YET"}</p>
            {programs.length>0&&<ActionBtn onClick={analyze} loading={analyzing} style={{marginBottom:14,width:"100%"}}>{analyzing?"Analyzing…":"Analyze My Style"}</ActionBtn>}
            {coachStyle?<p style={{fontSize:12,color:"#6ee7b7",lineHeight:1.7,maxHeight:340,overflow:"auto"}}>{coachStyle}</p>:<p style={{fontSize:12,color:"#374151",lineHeight:1.6}}>Add programs then analyze — AI learns your style and replicates it for every generated workout.</p>}
            {coachStyle&&<button onClick={()=>saveStyle("")} style={{marginTop:12,background:"none",border:"none",color:"#374151",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono',monospace"}}>Clear ×</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════════════════════════ */
function HistoryView({clients,history}) {
  const [sel,setSel]=useState(clients[0]?.name||null);
  const ch=(history[sel]||[]);
  return (
    <div>
      <PageHeader title="Workout History" subtitle="Past workouts are saved automatically and used to build progressive overload into every new session."/>
      {clients.length===0?<EmptySlate icon="⊙" title="No clients yet" body="Add clients and generate workouts — history builds automatically."/>:(
        <div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:32}}>
            {clients.map(c=>{ const count=(history[c.name]||[]).length; const lv=LEVEL_META[c.level||"medium"]; return (
              <button key={c.name} onClick={()=>setSel(c.name)} style={{padding:"8px 18px",borderRadius:100,fontSize:13,cursor:"pointer",fontWeight:500,border:`1px solid ${sel===c.name?lv.accent+"66":"rgba(255,255,255,0.06)"}`,background:sel===c.name?lv.glow:"transparent",color:sel===c.name?lv.accent:"#6b7280"}}>
                {c.name}{count>0&&<span style={{marginLeft:8,fontSize:10,opacity:0.5,fontFamily:"'DM Mono',monospace"}}>{count}</span>}
              </button>
            );})}
          </div>
          {sel&&ch.length===0&&<EmptySlate icon="⊙" title="No history yet" body="Workouts are saved here automatically at end of day."/>}
          {ch.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {ch.map((entry,i)=>{
                const d=new Date(entry.date+"T12:00:00");
                return (
                  <details key={i} open={i===0} style={{background:"#111827",border:"1px solid rgba(255,255,255,0.06)",borderRadius:14,overflow:"hidden"}}>
                    <summary style={{padding:"18px 22px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,listStyle:"none"}}>
                      <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#374151",minWidth:24}}>#{ch.length-i}</span>
                      <span style={{fontFamily:"'DM Serif Display',serif",fontSize:17,color:"#f9fafb",flex:1}}>{d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</span>
                      <span style={{fontSize:11,color:"#374151",fontFamily:"'DM Mono',monospace"}}>{parseSections(entry.workout).length} sections</span>
                    </summary>
                    <div style={{padding:"0 22px 22px",borderTop:"1px solid rgba(255,255,255,0.04)"}}>
                      <pre style={{whiteSpace:"pre-wrap",fontFamily:"'DM Sans',sans-serif",fontSize:13,lineHeight:1.75,color:"#9ca3af",margin:0,paddingTop:16}}>{entry.workout}</pre>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SHARED COMPONENTS + STYLE TOKENS
═══════════════════════════════════════════════════════════════ */
const INP={width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"10px 14px",color:"#e5e7eb",fontSize:13,lineHeight:1.5};
const LBL={display:"block",fontSize:11,fontFamily:"'DM Mono',monospace",letterSpacing:"0.1em",color:"#6b7280",marginBottom:4};

function PageHeader({title,subtitle}) {
  return (
    <div style={{marginBottom:38}}>
      <h1 style={{fontFamily:"'DM Serif Display',serif",fontSize:34,fontWeight:400,color:"#f9fafb",letterSpacing:"-0.01em",lineHeight:1.1}}>{title}</h1>
      {subtitle&&<p style={{marginTop:10,color:"#6b7280",fontSize:14,lineHeight:1.65,maxWidth:500}}>{subtitle}</p>}
    </div>
  );
}

function ActionBtn({children,onClick,secondary=false,small=false,loading=false,style={}}) {
  return (
    <button className="abtn" onClick={loading?undefined:onClick} style={{padding:small?"7px 14px":"10px 20px",borderRadius:10,border:"1px solid",fontSize:small?12:13,fontWeight:500,cursor:loading?"default":"pointer",fontFamily:"'DM Sans',sans-serif",display:"inline-flex",alignItems:"center",gap:7,whiteSpace:"nowrap",...(secondary?{background:"rgba(255,255,255,0.04)",borderColor:"rgba(255,255,255,0.08)",color:"#9ca3af"}:{background:"#f97316",borderColor:"#f97316",color:"#fff",boxShadow:"0 0 18px rgba(249,115,22,0.2)"}),transition:"all 0.15s",...style}}>
      {loading?"…":children}
    </button>
  );
}

function FormField({label,children}) {
  return (
    <div style={{marginBottom:16}}>
      <label style={{display:"block",fontSize:10,fontFamily:"'DM Mono',monospace",letterSpacing:"0.12em",color:"#4b5563",marginBottom:7}}>{label.toUpperCase()}</label>
      {children}
    </div>
  );
}

function EmptySlate({icon,title,body}) {
  return (
    <div style={{textAlign:"center",padding:"64px 24px"}}>
      <div style={{fontSize:34,marginBottom:16,opacity:0.15,fontFamily:"'DM Serif Display',serif"}}>{icon}</div>
      <h3 style={{fontFamily:"'DM Serif Display',serif",fontSize:21,fontWeight:400,color:"#6b7280",marginBottom:10}}>{title}</h3>
      <p style={{fontSize:13,color:"#374151",maxWidth:340,margin:"0 auto",lineHeight:1.65}}>{body}</p>
    </div>
  );
}
