/* Shared pure scheduling rules. No network or billing services. */
var Rules = (function () {
  const HOUR = 3600000;
  function dayKey(time, zone) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time));
    const get = t => parts.find(p => p.type === t).value;
    return get('year')+'-'+get('month')+'-'+get('day');
  }
  function addDays(key, n) { const d=new Date(key+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
  function week(time, zone) {
    const key=dayKey(time,zone), dow=new Date(key+'T12:00:00Z').getUTCDay();
    const start=addDays(key,-((dow+6)%7));
    return {start:start,end:addDays(start,6),exclusiveEnd:addDays(start,7)};
  }
  function inWeek(time, now, zone) { const w=week(now,zone), key=dayKey(time,zone); return key>=w.start && key<w.exclusiveEnd; }
  function config(description) {
    const clean=String(description||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:p|div|pre|li)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').split('\n--- Assistant attendance ---')[0];
    const capacities=[...clean.matchAll(/^Capacity:\s*(\d+)\s*$/gim)];
    const booking=[...clean.matchAll(/^Booking:\s*(open|closed)\s*$/gim)];
    const capacity=capacities.length===1?Number(capacities[0][1]):0;
    return {capacity:capacity,open:booking.length===1&&booking[0][1].toLowerCase()==='open',valid:capacity>=1&&capacity<=100&&booking.length===1,description:clean};
  }
  function active(b) { return ['confirmed','pending','cancel_pending'].includes(b.state); }
  function used(bookings,slotId,exclude) { return bookings.filter(b=>b.slotId===slotId&&b.id!==exclude&&active(b)).reduce((n,b)=>n+b.names.length,0); }
  function names(input) {
    if(!Array.isArray(input)||!input.length||input.length>100) throw Error('Enter the name of each participant.');
    const out=input.map(n=>String(n).trim().replace(/\s+/g,' '));
    if(out.some(n=>n.length<2||n.length>80||/[\r\n\x00-\x1f]/.test(n))) throw Error('Use a participant name between 2 and 80 characters.');
    if(new Set(out.map(n=>n.toLowerCase())).size!==out.length) throw Error('Each participant must have a different name.');
    return out;
  }
  function validate(slot,records,user,input,now,zone,exclude) {
    const ns=names(input);
    if(!slot||!slot.valid||!slot.open||slot.conflict) throw Error('This session is not available. Please refresh the week.');
    if(!inWeek(slot.start,now,zone)) throw Error('Only this week can be booked.');
    if(now>slot.start-4*HOUR) throw Error('Booking closed four hours before this session. Please choose a later time.');
    if(used(records,slot.id,exclude)+ns.length>slot.capacity) throw Error('There are not enough spaces left. Please refresh availability.');
    for(const b of records.filter(b=>active(b)&&b.id!==exclude)) {
      if(b.user===user&&b.slotId===slot.id) throw Error('You already have a reservation for this session. Cancel it before changing the party size.');
      if(slot.start<b.end&&slot.end>b.start&&b.names.some(n=>ns.some(x=>x.toLowerCase()===n.toLowerCase()))) throw Error('A participant may already be booked at this time. Please check your bookings or contact the leader.');
    }
    return ns;
  }
  function revision(s) { return JSON.stringify([s.start,s.end,s.capacity,s.open,s.title,s.location,s.notes]); }
  return {dayKey,addDays,week,inWeek,config,active,used,names,validate,revision};
})();
