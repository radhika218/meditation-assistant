/* Meditation Assistant. Google Apps Script only; no paid APIs. */
const OWNER = 'teacher@example.com';
const ZONE = 'America/Los_Angeles';
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('Meditation Assistant').addMetaTag('viewport','width=device-width, initial-scale=1');
}
function owner_() {
  if (Session.getActiveUser().getEmail().toLowerCase() !== OWNER) throw Error('Only the leader can run setup from the script editor.');
}
function locked_(fn) { const l=LockService.getScriptLock(); l.waitLock(20000); try {return fn();} finally {l.releaseLock();} }
function props_() {return PropertiesService.getScriptProperties();}
function setup() {
  owner_();
  return locked_(function(){
    const p=props_();
    if(!p.getProperty('CALENDAR_ID')) p.setProperty('CALENDAR_ID',CalendarApp.createCalendar('Meditation Sessions',{timeZone:ZONE,summary:'One event per slot. Description must contain Capacity: 1 and Booking: open.'}).getId());
    if(!p.getProperty('LEDGER_ID')) {
      const book=SpreadsheetApp.create('Meditation Assistant - private reservations');
      book.getSheets()[0].setName('Bookings').appendRow(['Private booking record (JSON)']);
      book.insertSheet('Access').appendRow(['Label','Private access code','Enabled']);
      book.insertSheet('Issues').appendRow(['Time','Issue']);
      p.setProperty('LEDGER_ID',book.getId());
    }
    const a=book_().getSheetByName('Access');
    if(a.getLastRow()===1) {
      const rows=Array.from({length:20},(_,i)=>['Student '+String(i+1).padStart(2,'0'),Utilities.getUuid().replace(/-/g,''),true]);
      a.getRange(2,1,rows.length,3).setValues(rows);
    }
    if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='maintenance')) ScriptApp.newTrigger('maintenance').timeBased().everyMinutes(5).create();
    return {calendar:'https://calendar.google.com/calendar/u/0/r',ledger:book_().getUrl(),status:'Ready. Add real slots to the calendar; no sample bookings were created.'};
  });
}
function book_() {const id=props_().getProperty('LEDGER_ID'); if(!id) throw Error('The leader has not finished setup.'); return SpreadsheetApp.openById(id);}
function calendar_() {const c=CalendarApp.getCalendarById(props_().getProperty('CALENDAR_ID')); if(!c) throw Error('Calendar connection needs attention.'); return c;}
function read_() {const s=book_().getSheetByName('Bookings'); return s.getLastRow()<2?[]:s.getRange(2,1,s.getLastRow()-1,1).getValues().map((r,i)=>Object.assign(JSON.parse(r[0]),{row:i+2}));}
function save_(b) {if(b.notice){b.notifications=b.notifications||[];b.notifications.push({subject:b.notice,start:b.start,names:b.names.slice(),key:Utilities.getUuid()});b.notice='';}const s=book_().getSheetByName('Bookings'); const value=Object.assign({},b);delete value.row; const json=JSON.stringify(value); if(b.row)s.getRange(b.row,1).setValue(json);else {s.appendRow([json]);b.row=s.getLastRow();} SpreadsheetApp.flush();}
function authenticate_(code) {
  if(typeof code!=='string'||!/^[a-f0-9]{32}$/.test(code))throw Error('Enter the private access code provided by your leader.');
  const a=book_().getSheetByName('Access');
  const rows=a.getLastRow()>1?a.getRange(2,1,a.getLastRow()-1,3).getValues():[];
  const match=rows.find(r=>r[1]===code&&(r[2]===true||String(r[2]).toLowerCase()==='true'));
  if(!match)throw Error('That access code is not active. Please contact your leader.');
  return {id:Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,code).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join(''),label:String(match[0])};
}
function slots_(now) {
  const events=calendar_().getEvents(new Date(now-8*86400000),new Date(now+8*86400000));
  const slots=events.filter(e=>!e.isAllDayEvent()&&!e.isRecurringEvent()).map(e=>{
    const c=Rules.config(e.getDescription()), s={id:e.getId(),title:e.getTitle(),start:e.getStartTime().getTime(),end:e.getEndTime().getTime(),capacity:c.capacity,open:c.open,valid:c.valid,location:e.getLocation()||'',notes:c.description,event:e};
    s.revision=Rules.revision(s);return s;
  });
  slots.forEach(s=>s.conflict=slots.some(t=>t.id!==s.id&&t.valid&&t.open&&s.start<t.end&&s.end>t.start));
  return slots.filter(s=>Rules.inWeek(s.start,now,ZONE)).sort((a,b)=>a.start-b.start);
}
function publicSlot_(s,records) {return {id:s.id,title:s.title,start:s.start,end:s.end,capacity:s.capacity,remaining:Math.max(0,s.capacity-Rules.used(records,s.id)),location:s.location,revision:s.revision,day:Rules.dayKey(s.start,ZONE)};}
function view_(user,now) {
  const records=read_(), slots=slots_(now);
  return {zone:ZONE,week:Rules.week(now,ZONE),now:now,label:user.label,slots:slots.filter(s=>s.valid&&s.open&&!s.conflict&&now<=s.start-14400000&&Rules.used(records,s.id)<s.capacity).map(s=>publicSlot_(s,records)),bookings:records.filter(b=>b.user===user.id&&Rules.active(b)).map(b=>({id:b.id,slotId:b.slotId,title:b.title,start:b.start,end:b.end,names:b.names,state:b.state,location:b.location,changed:!!b.changed}))};
}
function request(payload) {
  try {return locked_(function(){
    if(!payload||typeof payload!=='object')throw Error('Invalid request.');
    if(payload.action==='leader'){owner_();return leaderDashboard_();}
    const u=authenticate_(payload.code), now=Date.now();
    if(payload.action==='view')return {ok:true,data:view_(u,now)};
    if(!['reserve','cancel','reschedule'].includes(payload.action))throw Error('Unknown action.');
    if(typeof payload.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(payload.requestId))throw Error('Please reload before continuing.');
    const records=read_();
    const repeat=records.find(b=>b.user===u.id&&(b.requestId===payload.requestId||b.cancelRequestId===payload.requestId));
    if(repeat)return {ok:true,pending:repeat.state.includes('pending'),data:view_(u,now),message:'Your request has already been recorded.'};
    if(payload.action==='cancel') {
      const b=records.find(x=>x.id===payload.bookingId&&x.user===u.id&&x.state==='confirmed');
      if(!b)throw Error('This booking cannot be cancelled right now. Refresh your bookings.');
      b.state='cancel_pending';b.cancelRequestId=payload.requestId;b.updated=now;save_(b);settle_(b);
      return {ok:true,pending:b.state==='cancel_pending',data:view_(u,Date.now()),message:b.state==='cancelled'?'Reservation cancelled.':'Cancellation recorded; calendar update is pending.'};
    }
    let old=null;
    if(payload.action==='reschedule') {old=records.find(x=>x.id===payload.bookingId&&x.user===u.id&&x.state==='confirmed');if(!old)throw Error('Original booking is not available for rescheduling.');if(old.slotId===payload.slotId)throw Error('Choose a different session.');}
    const slot=slots_(now).find(s=>s.id===payload.slotId);
    if(!slot||slot.revision!==payload.revision)throw Error('The session details changed. Refresh and review the time before confirming.');
    const ns=Rules.validate(slot,records,u.id,old?old.names:payload.names,Date.now(),ZONE,old&&old.id);
    const b={id:Utilities.getUuid(),user:u.id,requestId:payload.requestId,slotId:slot.id,title:slot.title,start:slot.start,end:slot.end,names:ns,location:slot.location,revision:slot.revision,state:'pending',created:now,updated:now,replaces:old?old.id:null,notice:'',error:''};
    save_(b);settle_(b);
    if(b.state==='cancelled')throw Error('The session changed before confirmation. No new reservation was made.');
    return {ok:true,pending:b.state!=='confirmed',data:view_(u,Date.now()),message:b.state==='confirmed'?'Reservation confirmed. Your leader will receive an email.':'Request saved. Calendar confirmation is pending; check My bookings shortly.'};
  });} catch(e) {return {ok:false,error:String(e.message||e)};}
}
function attendance_(slotId,exclude) {
  const e=calendar_().getEventById(slotId);
  if(!e)return false;
  const desc=e.getDescription().split('\n--- Assistant attendance ---')[0];
  const c=Rules.config(desc),bs=read_().filter(b=>b.slotId===slotId&&Rules.active(b)&&b.state!=='cancel_pending'&&b.id!==exclude);
  const count=bs.reduce((n,b)=>n+b.names.length,0);
  const text='\n--- Assistant attendance ---\nBooked: '+count+' / '+c.capacity+'\nRemaining: '+Math.max(0,c.capacity-count)+'\n'+bs.map(b=>b.names.join(', ')).join('\n')+'\n--- End attendance ---';
  e.setDescription(desc+text);return true;
}
function settle_(b) {
  try {
    if(b.state==='cancel_pending') {attendance_(b.slotId,b.id);b.state='cancelled';b.notice='Cancellation';}
    else if(b.state==='pending') {
      const e=calendar_().getEventById(b.slotId);
      if(!e) {b.state='cancelled';b.notice='Booking could not complete: session removed';save_(b);return;}
      const c=Rules.config(e.getDescription());
      if(!c.valid||!c.open||e.getStartTime().getTime()!==b.start||e.getEndTime().getTime()!==b.end||Rules.used(read_(),b.slotId)>c.capacity) {b.state='cancelled';b.notice='Booking could not complete: session changed';save_(b);attendance_(b.slotId);return;}
      attendance_(b.slotId);
      if(b.replaces){const old=read_().find(x=>x.id===b.replaces);if(old&&old.state==='confirmed'){attendance_(old.slotId,old.id);old.state='cancelled';old.notice='';old.updated=Date.now();save_(old);}}
      b.state='confirmed';b.notice=b.replaces?'Rescheduled':'New booking';
    }
    b.error='';b.updated=Date.now();save_(b);
  } catch(e){b.error='Calendar update failed; retry scheduled.';save_(b);}
}
function maintenance() {
  // Trigger identity must match owner; cannot be invoked by anonymous web clients.
  owner_();
  return locked_(function(){
    const rows=read_();
    rows.filter(b=>b.state==='pending'||b.state==='cancel_pending').forEach(settle_);
    const current=read_();
    current.filter(b=>b.state==='confirmed'&&b.end>Date.now()-86400000).forEach(b=>{
      const e=calendar_().getEventById(b.slotId);
      if(!e){b.state='cancelled';b.notice='Leader removed session';b.updated=Date.now();save_(b);return;}
      const c=Rules.config(e.getDescription());
      const newStart=e.getStartTime().getTime(),newEnd=e.getEndTime().getTime();
      if(newStart!==b.start||newEnd!==b.end||e.getLocation()!==b.location){b.changed=true;b.start=newStart;b.end=newEnd;b.location=e.getLocation();b.notice='Session changed: please inform participants';b.updated=Date.now();save_(b);}
      if(c.capacity<Rules.used(current,b.slotId)&&!b.capacityIssue){b.capacityIssue=true;b.notice='Capacity below attendance: leader action needed';save_(b);}
    });
    const refreshed=read_();
    [...new Set(refreshed.filter(b=>Rules.active(b)&&b.end>Date.now()-86400000).map(b=>b.slotId))].forEach(id=>{try{attendance_(id);}catch(e){issue_('Calendar synchronization failed.');}});
    refreshed.filter(b=>b.notifications&&b.notifications.length).slice(0,30).forEach(b=>{
      const notification=b.notifications[0];
      if(MailApp.getRemainingDailyQuota()<1)return;
      try {
        const e=calendar_().getEventById(b.slotId),cap=e?Rules.config(e.getDescription()).capacity:'closed';
        const old=b.replaces?refreshed.find(x=>x.id===b.replaces):null;
        const when=Utilities.formatDate(new Date(notification.start),ZONE,'EEE, MMM d yyyy h:mm a');
        MailApp.sendEmail({to:OWNER,subject:'Meditation: '+notification.subject,body:notification.subject+'\n'+b.title+'\n'+when+' ('+ZONE+')\nParticipants: '+b.names.join(', ')+'\nBooked: '+Rules.used(read_(),b.slotId)+' / '+cap+'\nReference: '+b.id+(old?'\nPrevious: '+Utilities.formatDate(new Date(old.start),ZONE,'EEE, MMM d h:mm a'):'')});
        b.notifications.shift();b.notifiedAt=Date.now();save_(b);
      }catch(e){issue_('Leader email pending.');}
    });
  });
}
function issue_(message){book_().getSheetByName('Issues').appendRow([new Date().toISOString(),message]);}

// Never authorize the teacher view from a student access code or effective user.
function leaderDashboard_() {
 try { owner_(); return (function(){
  const now=Date.now(),records=read_();
  const sessions=slots_(now).map(s=>({title:s.title,start:s.start,end:s.end,capacity:s.capacity,valid:s.valid,open:s.open,conflict:s.conflict,location:s.location,booked:Rules.used(records,s.id),participants:records.filter(b=>b.slotId===s.id&&Rules.active(b)).map(b=>({names:b.names,state:b.state}))}));
  return {ok:true,week:Rules.week(now,ZONE),sessions:sessions,pendingEmails:records.reduce((n,b)=>n+(b.notifications||[]).length,0),updated:now};
 })(); } catch(e) {return {ok:false,error:'Teacher dashboard requires Google sign-in as '+OWNER+'. Open this app with that account; student access codes do not grant teacher access.'};}
}
