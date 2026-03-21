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
    <div style={{minHeight:"100vh",background:"#1a1a1a",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#555",fontSize:13,letterSpacing:"0.06em"}}>Loading…</div>
    </div>
  );

  return (
    <Shell view={view} setView={setView} notif={notif}>
      {view==="daily"   && <DailyView   clients={clients} programs={programs} coachStyle={coachStyle} history={history} todayData={todayData} saveToday={saveToday} calSettings={calSettings} notify={notify} setView={setView}/>}
      {view==="manage"  && <ManageView  clients={clients} saveClients={saveClients} notify={notify}/>}
      {view==="library" && <LibraryView programs={programs} savePrograms={savePrograms} coachStyle={coachStyle} saveStyle={saveStyle} notify={notify}/>}
      {view==="history" && <HistoryView clients={clients} history={history}/>}
      {view==="settings"&& <CalendarSettings calSettings={calSettings} saveCalSettings={saveCalSettings} notify={notify}/>}
    </Shell>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SHELL  — Fitera-style dark UI with bottom tab bar
═══════════════════════════════════════════════════════════════ */
const F = {
  bg:      "#1a1a1a",
  card:    "#252525",
  card2:   "#2e2e2e",
  text:    "#ffffff",
  text2:   "#888888",
  text3:   "#555555",
  purple:  "#8968CD",
  orange:  "#F4623A",
  radius:  "16px",
  font:    "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif",
};

function Shell({view,setView,notif,children}) {
  const NAV=[
    {id:"daily",    label:"Today",    svg:<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>},
    {id:"manage",   label:"Clients",  svg:<><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/><path d="M19 8v6M22 11h-6"/></>},
    {id:"library",  label:"Library",  svg:<><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></>},
    {id:"history",  label:"History",  svg:<><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 0 .5-4M3 3v5h5"/></>},
    {id:"settings", label:"Calendar", svg:<><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>},
  ];

  return (
    <div style={{minHeight:"100vh",background:F.bg,fontFamily:F.font,color:F.text}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:0;height:0}
        input,textarea,select{outline:none;font-family:${F.font};background:transparent;}
        button{cursor:pointer;font-family:${F.font};}
        @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .fe{animation:fadeUp 0.38s cubic-bezier(0.16,1,0.3,1) both;}
        .fe:nth-child(1){animation-delay:.03s}.fe:nth-child(2){animation-delay:.07s}
        .fe:nth-child(3){animation-delay:.11s}.fe:nth-child(4){animation-delay:.15s}
        .fe:nth-child(5){animation-delay:.19s}
        .nbtn{transition:opacity 0.15s;}
        .nbtn:active{opacity:0.6;}
        .abtn{transition:opacity 0.15s,transform 0.15s;}
        .abtn:active{opacity:0.75;transform:scale(0.97);}
        @media print{.no-print{display:none!important;}body{background:white!important;}.print-card{page-break-after:always;}}
      `}</style>

      {notif&&(
        <div style={{position:"fixed",top:20,right:20,left:20,zIndex:9999,padding:"14px 18px",borderRadius:14,fontSize:14,fontWeight:500,background:notif.type==="err"?"#3a1a1a":notif.type==="warn"?"#3a2e00":"#1a2e1a",color:notif.type==="err"?"#ff6b6b":notif.type==="warn"?"#fbbf24":"#6ee7b7",boxShadow:"0 8px 40px rgba(0,0,0,0.7)",textAlign:"center"}}>
          {notif.msg}
        </div>
      )}

      {/* Page content */}
      <div style={{maxWidth:600,margin:"0 auto",padding:"28px 20px 110px"}}>
        {children}
      </div>

      {/* Bottom tab bar — Fitera style */}
      <div className="no-print" style={{position:"fixed",bottom:0,left:0,right:0,zIndex:200,display:"flex",justifyContent:"center",paddingBottom:"max(20px,env(safe-area-inset-bottom))",paddingTop:10,background:`linear-gradient(transparent,${F.bg} 40%)`}}>
        <div style={{display:"flex",gap:4,background:"#2a2a2a",borderRadius:100,padding:"8px 10px",boxShadow:"0 4px 32px rgba(0,0,0,0.6)"}}>
          {NAV.map(n=>{
            const active=view===n.id;
            return (
              <button key={n.id} className="nbtn" onClick={()=>setView(n.id)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:active?"8px 18px":"8px 14px",borderRadius:100,border:"none",background:active?"#383838":"transparent",color:active?F.text:F.text3,transition:"all 0.2s",minWidth:active?72:52}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{n.svg}</svg>
                {active&&<span style={{fontSize:10,fontWeight:600,letterSpacing:"0.01em",color:F.text}}>{n.label}</span>}
              </button>
            );
          })}
        </div>
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
            <div key={cal.id} style={{background:"#252525",border:`1px solid ${isOn?"rgba(255,255,255,0.1)":"rgba(255,255,255,0.05)"}`,borderRadius:16,overflow:"hidden"}}>
              <div style={{padding:"20px 24px",display:"flex",alignItems:"center",gap:16,borderBottom:isOn?"1px solid rgba(255,255,255,0.05)":"none"}}>
                <div style={{width:40,height:40,borderRadius:10,background:`${cal.color}18`,border:`1px solid ${cal.color}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{cal.icon}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:600,color:"#fff",marginBottom:3}}>{cal.name}</div>
                  <div style={{fontSize:12,color:"#888",lineHeight:1.5}}>{cal.howto}</div>
                </div>
                <div onClick={()=>update(cal.id,"enabled",!isOn)} style={{width:44,height:24,borderRadius:12,cursor:"pointer",background:isOn?"#f97316":"rgba(255,255,255,0.08)",position:"relative",border:`1px solid ${isOn?"#f97316":"rgba(255,255,255,0.1)"}`,flexShrink:0,transition:"background 0.2s"}}>
                  <div style={{position:"absolute",top:2,left:isOn?22:2,width:18,height:18,borderRadius:9,background:"white",transition:"left 0.2s",boxShadow:"0 1px 4px rgba(0,0,0,0.3)"}}/>
                </div>
              </div>
              {isOn&&(
                <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:16}}>
                  <div>
                    <label style={LBL}>iCal Feed URL</label>
                    <input value={s.icalUrl} onChange={e=>update(cal.id,"icalUrl",e.target.value)} placeholder="webcal://... or https://calendar.google.com/calendar/ical/..." style={{...INP,marginTop:6,fontSize:11}}/>
                  </div>
                  <div>
                    <label style={LBL}>How are your events titled?</label>
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
                      {FORMAT_OPTIONS.map(f=>(
                        <label key={f.id} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"10px 14px",borderRadius:10,cursor:"pointer",border:`1px solid ${s.format===f.id?"rgba(249,115,22,0.4)":"rgba(255,255,255,0.06)"}`,background:s.format===f.id?"rgba(249,115,22,0.06)":"transparent"}}>
                          <div style={{width:16,height:16,borderRadius:8,marginTop:1,flexShrink:0,border:`2px solid ${s.format===f.id?"#f97316":"#555"}`,background:s.format===f.id?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>update(cal.id,"format",f.id)}>
                            {s.format===f.id&&<div style={{width:6,height:6,borderRadius:3,background:"white"}}/>}
                          </div>
                          <div style={{flex:1}} onClick={()=>update(cal.id,"format",f.id)}>
                            <div style={{fontSize:13,fontWeight:500,color:s.format===f.id?"#fff":"#aaa",marginBottom:2}}>{f.label}</div>
                            <div style={{fontSize:11,color:"#555"}}>{f.desc}</div>
                            {f.example&&<div style={{marginTop:4,fontSize:11,color:"#888",padding:"3px 8px",background:"#2e2e2e",borderRadius:4,display:"inline-block"}}>{f.example}</div>}
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
  const [syncing,setSyncing]       = useState({google:false,apple:false});
  const [generating,setGenerating] = useState({});
  const [sharePopup,setSharePopup] = useState(null);
  const [selectedDate,setSelectedDate] = useState(TODAY_KEY());
  const [weekOffset,setWeekOffset]     = useState(0);

  const sessions = todayData?.sessions||[];
  const workouts = todayData?.workouts||{};

  const matchClient = name =>
    clients.find(c=>c.name.toLowerCase()===name?.toLowerCase())||
    clients.find(c=>name?.toLowerCase()?.includes(c.name.toLowerCase()))||
    clients.find(c=>c.name.toLowerCase().includes(name?.toLowerCase()||""));

  const syncCal = async (calType, silent=false) => {
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
        if(newSessions.length) {
          await saveToday({...todayData,sessions:[...sessions,...newSessions]});
          if(!silent) notify(`${newSessions.length} session${newSessions.length>1?"s":""} loaded from ${calType==="apple"?"Apple":"Google"} Calendar`);
        } else if(!silent) {
          notify(`${parsed.length} session${parsed.length>1?"s":""} already up to date`);
        }
      } else if(!silent) {
        notify(`No training sessions found in ${calType==="apple"?"Apple":"Google"} Calendar today`,"warn");
      }
    } catch(e) { if(!silent) notify(`Sync failed — ${e.message}`,"err"); }
    setSyncing(p=>({...p,[calType]:false}));
  };

  const syncAll = (silent=false)=>{ if(calSettings.google?.enabled)syncCal("google",silent); if(calSettings.apple?.enabled)syncCal("apple",silent); };

  // Auto-populate from calendar on mount when settings are configured
  useEffect(()=>{ syncAll(true); },[]);  // eslint-disable-line react-hooks/exhaustive-deps

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
    const shareDate=isViewingToday?new Date():new Date(selectedDate+"T12:00:00");
    const text=`${clientName} — ${shareDate.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}\n\n${viewWorkouts[clientName]}`;
    try { await navigator.clipboard.writeText(text); setSharePopup(clientName); setTimeout(()=>setSharePopup(null),2000); } catch {}
  };

  const today=new Date();
  const todayKey=TODAY_KEY();
  const isViewingToday=selectedDate===todayKey;

  // For past dates reconstruct from history; today uses live todayData
  let viewSessions=sessions, viewWorkouts=workouts;
  if(!isViewingToday) {
    const ps=[]; const pw={};
    for(const [name,entries] of Object.entries(history)) {
      const e=entries.find(en=>en.date===selectedDate);
      if(e){ ps.push({clientName:name,time:""}); pw[name]=e.workout; }
    }
    viewSessions=ps; viewWorkouts=pw;
  }

  const hasWorkouts=viewSessions.filter(s=>viewWorkouts[s.clientName]).length;
  const anyEnabled=calSettings.google?.enabled||calSettings.apple?.enabled;
  const bothEnabled=calSettings.google?.enabled&&calSettings.apple?.enabled;
  const isSyncing=syncing.google||syncing.apple;

  // Week strip — 7 days offset by weekOffset
  const weekDays=Array.from({length:7},(_,i)=>{
    const d=new Date(today); d.setDate(today.getDate()-today.getDay()+i+weekOffset*7);
    return d;
  });
  const DAY_NAMES=["SUN","MON","TUE","WED","THU","FRI","SAT"];

  return (
    <div>
      {/* Header */}
      <div style={{marginBottom:24}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div>
            <h1 style={{fontSize:34,fontWeight:700,color:"#fff",letterSpacing:"-0.5px"}}>
              {isViewingToday?"Home":new Date(selectedDate+"T12:00:00").toLocaleDateString("en-US",{month:"long",day:"numeric"})}
            </h1>
            <p style={{fontSize:15,color:"#888",marginTop:2}}>
              {isViewingToday
                ? today.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})
                : new Date(selectedDate+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
              {!isViewingToday&&<span style={{marginLeft:8,fontSize:11,color:F.orange,fontWeight:700,letterSpacing:"0.06em"}}>PAST</span>}
            </p>
          </div>
          <div style={{display:"flex",gap:8}}>
            {isViewingToday&&anyEnabled&&(
              <button className="nbtn" onClick={isSyncing?undefined:syncAll} style={{width:42,height:42,borderRadius:21,background:"#252525",border:"none",color:isSyncing?"#555":"#fff",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center"}}>
                {isSyncing?"…":"⟳"}
              </button>
            )}
            {isViewingToday&&!anyEnabled&&(
              <button className="nbtn" onClick={()=>setView("settings")} style={{height:42,padding:"0 16px",borderRadius:21,background:"#252525",border:"none",color:"#888",fontSize:13,fontWeight:600}}>
                + Calendar
              </button>
            )}
            {!isViewingToday&&(
              <button className="nbtn" onClick={()=>{setSelectedDate(todayKey);setWeekOffset(0);}} style={{height:42,padding:"0 16px",borderRadius:21,background:"#252525",border:"none",color:F.orange,fontSize:13,fontWeight:600}}>
                Today
              </button>
            )}
          </div>
        </div>

        {/* Week strip */}
        <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:24}}>
          <button className="nbtn" onClick={()=>setWeekOffset(p=>p-1)} style={{width:28,height:28,borderRadius:14,border:"none",background:"#252525",color:"#666",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>‹</button>
          <div style={{flex:1,display:"flex",justifyContent:"space-between"}}>
            {weekDays.map((d,i)=>{
              const isToday=d.toDateString()===today.toDateString();
              const dKey=d.toISOString().slice(0,10);
              const isSelected=dKey===selectedDate;
              const isFuture=d>today;
              const hasPastData=!isToday&&!isFuture&&Object.values(history).some(entries=>entries.some(e=>e.date===dKey));
              return (
                <div key={i} onClick={()=>!isFuture&&setSelectedDate(dKey)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6,cursor:isFuture?"default":"pointer",opacity:isFuture?0.3:1}}>
                  <span style={{fontSize:11,fontWeight:600,color:isSelected||isToday?F.orange:"#555",letterSpacing:"0.04em"}}>{DAY_NAMES[i]}</span>
                  <div style={{width:38,height:38,borderRadius:10,background:isSelected?"#3a3a3a":isToday?"#333":"transparent",border:isSelected?`2px solid ${F.orange}`:"2px solid transparent",display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                    <span style={{fontSize:18,fontWeight:isSelected||isToday?700:400,color:isSelected||isToday?"#fff":"#666"}}>{d.getDate()}</span>
                    {hasPastData&&!isSelected&&<div style={{position:"absolute",bottom:4,width:4,height:4,borderRadius:2,background:"#555"}}/>}
                  </div>
                </div>
              );
            })}
          </div>
          <button className="nbtn" onClick={()=>setWeekOffset(p=>Math.min(p+1,0))} disabled={weekOffset>=0} style={{width:28,height:28,borderRadius:14,border:"none",background:"#252525",color:weekOffset>=0?"#2e2e2e":"#666",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>›</button>
        </div>

        {/* Workouts section header */}
        <SectionHeader icon="🏋️" title="Workouts" sub={isViewingToday?`${viewSessions.length} ${viewSessions.length===1?"Session":"Sessions"} Today`:`${viewSessions.length} ${viewSessions.length===1?"Session":"Sessions"} · ${new Date(selectedDate+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})}`}/>

        {/* Client quick-add chips — today only */}
        {isViewingToday&&clients.length>0&&(
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
            {clients.map(c=>{
              const already=sessions.find(s=>s.clientName===c.name);
              return (
                <button key={c.name} className="nbtn" onClick={()=>{ if(!already)saveToday({...todayData,sessions:[...sessions,{clientName:c.name,time:""}]}); }} style={{padding:"7px 14px",borderRadius:100,fontSize:13,fontWeight:600,border:"none",background:already?"#383838":F.purple+"33",color:already?"#fff":F.purple}}>
                  {already?"✓ ":""}{c.name}
                </button>
              );
            })}
            {sessions.length>0&&hasWorkouts<sessions.length&&(
              <button className="nbtn" onClick={generateAll} style={{padding:"7px 14px",borderRadius:100,fontSize:13,fontWeight:600,border:"none",background:F.orange,color:"#fff",marginLeft:"auto"}}>
                ⚡ Generate All
              </button>
            )}
          </div>
        )}
      </div>

      {viewSessions.length===0?(
        <EmptySlate icon="🏋️" title={isViewingToday?"No sessions today":"No sessions on this day"} body={isViewingToday?(clients.length===0?"Add clients first, then sync your calendar.":"Sync your calendar or tap a client name above."):"No workouts were recorded for this date."}/>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {viewSessions.map((s,i)=>{
            const client=matchClient(s.clientName);
            const lv=LEVEL_META[client?.level||"medium"];
            const workout=viewWorkouts[s.clientName];
            const isGen=isViewingToday&&generating[s.clientName];
            const sections=workout?parseSections(workout):[];
            const iconColors=["#8968CD","#E05A3A","#E09B2A","#3A8EE0","#3AB87A"];
            const iconBg=iconColors[i%iconColors.length];
            return (
              <div key={i} className="fe print-card" style={{background:"#252525",borderRadius:16,overflow:"hidden"}}>
                {/* Row header */}
                <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px"}}>
                  <div style={{width:44,height:44,borderRadius:12,background:iconBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:22}}>🏃</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:16,fontWeight:700,color:"#fff"}}>{s.clientName}</div>
                    <div style={{fontSize:13,color:"#888",marginTop:1}}>
                      {s.time?`${s.time} · `:""}{lv.label}
                      {client?.equipment?.length?" · "+client.equipment.slice(0,2).join(", "):""}
                    </div>
                  </div>
                  <div className="no-print" style={{display:"flex",gap:8,alignItems:"center"}}>
                    {isViewingToday&&!workout&&!isGen&&(
                      <button className="abtn" onClick={()=>generate(s.clientName)} style={{height:36,padding:"0 16px",borderRadius:100,border:"none",background:F.orange,color:"#fff",fontSize:13,fontWeight:700}}>
                        ⚡ Generate
                      </button>
                    )}
                    {isGen&&<span style={{fontSize:13,color:"#888",animation:"pulse 1.4s infinite"}}>Building…</span>}
                    {isViewingToday&&workout&&!isGen&&(
                      <button className="nbtn" onClick={()=>generate(s.clientName)} style={{width:36,height:36,borderRadius:18,border:"none",background:"#333",color:"#aaa",fontSize:14}}>↺</button>
                    )}
                    {workout&&!isGen&&(
                      <button className="nbtn" onClick={()=>shareCard(s.clientName)} style={{width:36,height:36,borderRadius:18,border:"none",background:"#333",color:"#aaa",fontSize:14}}>
                        {sharePopup===s.clientName?"✓":"⎘"}
                      </button>
                    )}
                    {isViewingToday&&<button className="nbtn" onClick={()=>{ const ns=sessions.filter((_,j)=>j!==i); const nw={...workouts}; delete nw[s.clientName]; saveToday({...todayData,sessions:ns,workouts:nw}); }} style={{width:36,height:36,borderRadius:18,border:"none",background:"#333",color:"#888",fontSize:16}}>×</button>}
                  </div>
                </div>

                {/* Workout content */}
                {workout&&!isGen&&(
                  <div style={{borderTop:"1px solid #1a1a1a",padding:"16px 16px 4px"}}>
                    {sections.map((sec,si)=>{
                      const isNotes=sec.title.toLowerCase().includes("coach")||sec.title.toLowerCase().includes("note");
                      return (
                        <div key={si} style={{marginBottom:16}}>
                          <p style={{fontSize:11,fontWeight:700,color:isNotes?iconBg:"#555",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:8}}>{sec.title.replace(/\(.*?\)/,"").trim()}</p>
                          {sec.lines.map((line,li)=>{
                            if(!line.trim())return null;
                            const isExercise=/sets|reps|×|x\s*\d|@\s*\d|rounds|AMRAP|min\s/i.test(line);
                            const clean=line.replace(/^\s*[-•–·]\s*/,"").replace(/^\s*[A-Z]\d+\.\s*/,"").trim();
                            if(!clean)return null;
                            return (
                              <div key={li} style={{display:"flex",alignItems:"center",gap:10,padding:isExercise?"10px 12px":"4px 0",background:isExercise?"#2e2e2e":"transparent",borderRadius:isExercise?10:0,marginBottom:isExercise?6:0}}>
                                {isExercise&&<div style={{width:3,height:3,borderRadius:2,background:iconBg,flexShrink:0}}/>}
                                <span style={{fontSize:14,lineHeight:1.55,color:isNotes?"#888":isExercise?"#f0f0f0":"#aaa",fontStyle:isNotes?"italic":"normal",fontWeight:isExercise?500:400}}>{clean}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    <RegenRow onRegen={note=>generate(s.clientName,note)}/>
                  </div>
                )}

                {/* Shimmer skeleton */}
                {isGen&&(
                  <div style={{padding:"0 16px 16px",borderTop:"1px solid #1a1a1a",paddingTop:16}}>
                    {[90,70,80,55].map((w,n)=>(
                      <div key={n} style={{height:14,borderRadius:7,width:`${w}%`,marginBottom:10,background:"linear-gradient(90deg,#2a2a2a 25%,#333 50%,#2a2a2a 75%)",backgroundSize:"200% 100%",animation:"shimmer 1.6s infinite"}}/>
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

function RegenRow({onRegen}) {
  const [note,setNote]=useState(""); const [open,setOpen]=useState(false);
  return (
    <div className="no-print" style={{marginBottom:12}}>
      {!open&&<button className="nbtn" onClick={()=>setOpen(true)} style={{fontSize:13,color:"#555",background:"none",border:"none",padding:0}}>+ Add instructions and regenerate</button>}
      {open&&(
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. posterior chain focus, 40 min cap…" onKeyDown={e=>{ if(e.key==="Enter"){onRegen(note);setOpen(false);setNote("");} }} style={{flex:1,...INP,fontSize:14}}/>
          <button className="abtn" onClick={()=>{onRegen(note);setOpen(false);setNote("");}} style={{height:44,padding:"0 16px",borderRadius:12,border:"none",background:F.orange,color:"#fff",fontWeight:700,fontSize:14}}>↺</button>
          <button className="nbtn" onClick={()=>setOpen(false)} style={{background:"none",border:"none",color:"#555",fontSize:20}}>×</button>
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
      <div style={{display:"flex",flexDirection:"column",gap:20}}>
        <div style={{background:"#252525",borderRadius:16,padding:20}}>
          <p style={{fontSize:10,letterSpacing:"0.14em",color:"#555",marginBottom:18,display:"flex",justifyContent:"space-between"}}>
            <span>{editIdx!==null?"EDIT CLIENT":"NEW CLIENT"}</span>
            <span style={{color:"#14532d"}}>● AUTO-SAVED</span>
          </p>
          <FormField label="Name"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Full name" style={INP}/></FormField>
          <FormField label="Fitness Level">
            <div style={{display:"flex",gap:8}}>
              {Object.entries(LEVEL_META).map(([k,v])=>(
                <button key={k} onClick={()=>setForm(p=>({...p,level:k}))} style={{flex:1,padding:"8px 4px",borderRadius:8,cursor:"pointer",fontWeight:500,letterSpacing:"0.1em",fontSize:11,border:`1px solid ${form.level===k?v.accent+"66":"rgba(255,255,255,0.06)"}`,background:form.level===k?v.glow:"transparent",color:form.level===k?v.accent:"#888"}}>{v.short}</button>
              ))}
            </div>
          </FormField>
          <FormField label="Equipment">
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {EQUIPMENT_OPTIONS.map(eq=>{ const on=form.equipment.includes(eq); return <button key={eq} onClick={()=>toggleEquip(eq)} style={{padding:"4px 10px",borderRadius:100,fontSize:11,cursor:"pointer",border:`1px solid ${on?"#60a5fa44":"rgba(255,255,255,0.06)"}`,background:on?"rgba(96,165,250,0.07)":"transparent",color:on?"#93c5fd":"#888"}}>{eq}</button>; })}
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
            {form.spaceImages?.length>0&&<div style={{marginTop:10,display:"flex",gap:8,flexWrap:"wrap"}}>{form.spaceImages.map((img,i)=><div key={i} style={{position:"relative"}}><img src={img.preview} alt="" style={{width:60,height:60,objectFit:"cover",borderRadius:8,}}/><button onClick={()=>setForm(p=>({...p,spaceImages:p.spaceImages.filter((_,j)=>j!==i)}))} style={{position:"absolute",top:-5,right:-5,width:16,height:16,borderRadius:"50%",background:"#1f0a0a",border:"1px solid #7f1d1d",color:"#f87171",cursor:"pointer",fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>×</button></div>)}</div>}
            {form.spaceAnalysis&&<p style={{marginTop:10,fontSize:11,color:"#7dd3fc",lineHeight:1.6,padding:"10px 12px",background:"rgba(56,189,248,0.04)",border:"1px solid rgba(56,189,248,0.12)",borderRadius:8}}>{form.spaceAnalysis}</p>}
          </FormField>
          <div style={{display:"flex",gap:10}}>
            <ActionBtn onClick={save}>{editIdx!==null?"Save Changes":"Add Client"}</ActionBtn>
            {editIdx!==null&&<ActionBtn secondary onClick={openNew}>Cancel</ActionBtn>}
          </div>
        </div>
        <div>
          <p style={{fontSize:10,letterSpacing:"0.14em",color:"#555",marginBottom:16}}>ROSTER — {clients.length} CLIENTS</p>
          {clients.length===0?<EmptySlate icon="◈" title="No clients yet" body="Add your first client using the form."/>:(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {clients.map((c,i)=>{ const lv=LEVEL_META[c.level||"medium"]; const avoids=c.avoid?.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean)||[]; return (
                <div key={i} style={{background:"#252525",border:`1px solid ${lv.accent}22`,borderRadius:14,padding:"18px 20px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,flexWrap:"wrap"}}>
                        <h3 style={{fontSize:19,fontWeight:400,color:"#fff"}}>{c.name}</h3>
                        <span style={{padding:"2px 9px",borderRadius:100,background:lv.glow,border:`1px solid ${lv.accent}44`,color:lv.accent,fontSize:10,fontFamily:"'DM Mono',monospace"}}>{lv.short}</span>
                        {avoids.length>0&&<span style={{fontSize:10,color:"#7f1d1d",fontFamily:"'DM Mono',monospace"}}>⛔ {avoids.length}</span>}
                      </div>
                      {c.equipment?.length>0&&<p style={{fontSize:12,color:"#555",lineHeight:1.5}}>{c.equipment.join("  ·  ")}</p>}
                      {c.notes&&<p style={{marginTop:5,fontSize:12,color:"#888",fontStyle:"italic",lineHeight:1.5}}>{c.notes}</p>}
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
      <div style={{display:"flex",flexDirection:"column",gap:16}}>
        <div>
          <div style={{background:"#252525",borderRadius:16,padding:20,marginBottom:16}}>
            <p style={{fontSize:10,letterSpacing:"0.14em",color:"#555",marginBottom:14}}>PASTE PROGRAM</p>
            <input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="Program name" style={{...INP,marginBottom:10}}/>
            <textarea value={form.content} onChange={e=>setForm(p=>({...p,content:e.target.value}))} rows={8} placeholder={"A1. Back Squat  5×5 @ 80%  — 3:00 rest\nA2. Romanian DL  4×8  — 2:00 rest\n\nConditioning: 4 rounds\n  400m Run / 20 KB Swings / 15 Box Jumps"} style={{...INP,resize:"vertical",lineHeight:1.65,fontSize:12}}/>
            <div style={{display:"flex",gap:10,marginTop:12}}>
              <ActionBtn onClick={add}>Add</ActionBtn>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md" onChange={uploadFile} style={{display:"none"}}/>
              <ActionBtn secondary onClick={()=>fileRef.current?.click()}>Upload PDF / TXT</ActionBtn>
            </div>
          </div>
          {programs.length===0?<EmptySlate icon="⊞" title="Library empty" body="Paste or upload programs above."/>:(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {programs.map((p,i)=>(
                <div key={i} style={{background:"#252525",borderRadius:12,padding:"16px 18px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <h4 style={{fontSize:17,fontWeight:400,color:"#fff"}}>{p.name}</h4>
                    <button onClick={()=>del(i)} style={{background:"rgba(127,29,29,0.1)",border:"1px solid rgba(127,29,29,0.2)",borderRadius:6,color:"#f87171",cursor:"pointer",fontSize:11,padding:"3px 10px",fontFamily:"'DM Mono',monospace"}}>Remove</button>
                  </div>
                  <pre style={{whiteSpace:"pre-wrap",fontSize:11,lineHeight:1.7,color:"#555",margin:0,maxHeight:130,overflow:"auto"}}>{p.content}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{position:"sticky",top:74}}>
          <div style={{background:"#252525",border:`1px solid ${coachStyle?"rgba(110,231,183,0.2)":"rgba(255,255,255,0.05)"}`,borderRadius:14,padding:20}}>
            <p style={{fontSize:10,letterSpacing:"0.14em",color:coachStyle?"#6ee7b7":"#555",marginBottom:12}}>{coachStyle?"◉ STYLE LEARNED":"◎ NO STYLE YET"}</p>
            {programs.length>0&&<ActionBtn onClick={analyze} loading={analyzing} style={{marginBottom:14,width:"100%"}}>{analyzing?"Analyzing…":"Analyze My Style"}</ActionBtn>}
            {coachStyle?<p style={{fontSize:12,color:"#6ee7b7",lineHeight:1.7,maxHeight:340,overflow:"auto"}}>{coachStyle}</p>:<p style={{fontSize:12,color:"#555",lineHeight:1.6}}>Add programs then analyze — AI learns your style and replicates it for every generated workout.</p>}
            {coachStyle&&<button onClick={()=>saveStyle("")} style={{marginTop:12,background:"none",border:"none",color:"#555",cursor:"pointer",fontSize:11,fontFamily:"'DM Mono',monospace"}}>Clear ×</button>}
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
              <button key={c.name} onClick={()=>setSel(c.name)} style={{padding:"8px 18px",borderRadius:100,fontSize:13,cursor:"pointer",fontWeight:500,border:`1px solid ${sel===c.name?lv.accent+"66":"rgba(255,255,255,0.06)"}`,background:sel===c.name?lv.glow:"transparent",color:sel===c.name?lv.accent:"#888"}}>
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
                  <details key={i} open={i===0} style={{background:"#252525",borderRadius:14,overflow:"hidden"}}>
                    <summary style={{padding:"18px 22px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,listStyle:"none"}}>
                      <span style={{fontSize:10,color:"#555",minWidth:24}}>#{ch.length-i}</span>
                      <span style={{fontSize:17,color:"#fff",flex:1}}>{d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</span>
                      <span style={{fontSize:11,color:"#555",fontFamily:"'DM Mono',monospace"}}>{parseSections(entry.workout).length} sections</span>
                    </summary>
                    <div style={{padding:"0 22px 22px",borderTop:"1px solid rgba(255,255,255,0.04)"}}>
                      <pre style={{whiteSpace:"pre-wrap",fontSize:13,lineHeight:1.75,color:"#aaa",margin:0,paddingTop:16}}>{entry.workout}</pre>
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
const INP={width:"100%",background:"#2e2e2e",border:"none",borderRadius:12,padding:"12px 16px",color:"#fff",fontSize:15,lineHeight:1.5};
const LBL={display:"block",fontSize:12,fontWeight:600,color:"#888",marginBottom:8,letterSpacing:"0.01em"};

function SectionHeader({icon,title,sub}) {
  return (
    <div style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
        {icon&&<span style={{fontSize:18}}>{icon}</span>}
        <span style={{fontSize:22,fontWeight:700,color:"#fff",letterSpacing:"-0.3px"}}>{title}</span>
      </div>
      {sub&&<p style={{fontSize:14,color:"#888",marginLeft:icon?26:0}}>{sub}</p>}
    </div>
  );
}

function PageHeader({title,subtitle}) {
  return (
    <div style={{marginBottom:28}}>
      <h1 style={{fontSize:34,fontWeight:700,color:"#fff",letterSpacing:"-0.5px",lineHeight:1.1}}>{title}</h1>
      {subtitle&&<p style={{marginTop:8,color:"#888",fontSize:14,lineHeight:1.6}}>{subtitle}</p>}
    </div>
  );
}

function ActionBtn({children,onClick,secondary=false,small=false,loading=false,style={}}) {
  return (
    <button className="abtn" onClick={loading?undefined:onClick} style={{padding:small?"9px 18px":"12px 22px",borderRadius:100,border:"none",fontSize:small?13:15,fontWeight:600,display:"inline-flex",alignItems:"center",gap:7,whiteSpace:"nowrap",...(secondary?{background:"#2e2e2e",color:"#aaa"}:{background:F.orange,color:"#fff"}),transition:"opacity 0.15s,transform 0.15s",...style}}>
      {loading?"…":children}
    </button>
  );
}

function FormField({label,children}) {
  return (
    <div style={{marginBottom:18}}>
      <label style={{display:"block",fontSize:12,fontWeight:600,color:"#888",marginBottom:8}}>{label}</label>
      {children}
    </div>
  );
}

function FCard({children,style={}}) {
  return <div style={{background:"#252525",borderRadius:16,overflow:"hidden",...style}}>{children}</div>;
}

function FRow({left,title,sub,right,onClick}) {
  return (
    <div onClick={onClick} style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",background:"#252525",borderRadius:14,cursor:onClick?"pointer":"default"}}>
      {left&&<div style={{width:44,height:44,borderRadius:12,background:F.purple,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:22}}>{left}</div>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:16,fontWeight:600,color:"#fff",lineHeight:1.2}}>{title}</div>
        {sub&&<div style={{fontSize:13,color:"#888",marginTop:2}}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function EmptySlate({icon,title,body}) {
  return (
    <div style={{textAlign:"center",padding:"60px 24px"}}>
      <div style={{fontSize:48,marginBottom:16,opacity:0.2}}>{icon}</div>
      <h3 style={{fontSize:20,fontWeight:700,color:"#555",marginBottom:8}}>{title}</h3>
      <p style={{fontSize:14,color:"#444",maxWidth:300,margin:"0 auto",lineHeight:1.6}}>{body}</p>
    </div>
  );
}
