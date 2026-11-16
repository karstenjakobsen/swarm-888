import type { z } from 'zod';
import type { jobSchedule } from './schemas.ts';

type Schedule=z.infer<typeof jobSchedule>;
const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const days=['SUN','MON','TUE','WED','THU','FRI','SAT'];
function field(text:string,min:number,max:number,names:string[]=[],offset=0):Set<number>{
  const result=new Set<number>();
  const number=(raw:string)=>{const index=names.indexOf(raw.toUpperCase()),value=index<0?Number(raw):index+offset;if(!/^\d+$/.test(raw)&&index<0||!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid cron field: ${text}`);return value;};
  for(const part of text.split(',')){
    const pieces=part.split('/');if(pieces.length>2)throw new Error('Invalid cron step');
    const step=pieces[1]===undefined?1:Number(pieces[1]);if(pieces[1]!==undefined&&!/^\d+$/.test(pieces[1])||!Number.isInteger(step)||step<1||step>max-min+1)throw new Error('Invalid cron step');
    const range=pieces[0]==='*'?[min,max]:pieces[0]!.split('-').map(number);
    if(range.length>2||range[0]!>(range[1]??range[0]!))throw new Error('Invalid cron range');
    const end=range[1]??(pieces[1]===undefined?range[0]!:max);
    for(let value=range[0]!;value<=end;value+=step)result.add(max===7&&value===7?0:value);
  }
  return result;
}
export function parseCron(expression:string){
  const fields=expression.trim().split(/\s+/);if(fields.length!==5)throw new Error('Use a five-field cron expression');
  return {minute:field(fields[0]!,0,59),hour:field(fields[1]!,0,23),day:field(fields[2]!,1,31),month:field(fields[3]!,1,12,months,1),weekday:field(fields[4]!,0,7,days),anyDay:fields[2]!.startsWith('*'),anyWeekday:fields[4]!.startsWith('*')};
}
const formatters=new Map<string,Intl.DateTimeFormat>();
const minuteMs=60_000,dayMs=86400_000;
function localParts(time:number,formatter:Intl.DateTimeFormat){
  const parts=Object.fromEntries(formatter.formatToParts(new Date(time)).map(part=>[part.type,part.value]));
  return {date:Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)),hour:Number(parts.hour),minute:Number(parts.minute)};
}

export function nextScheduledAt(schedule:Schedule,after:number):string {
  if(schedule.type==='interval')return new Date(after+schedule.seconds*1000).toISOString();
  const cron=parseCron(schedule.expression),timezone=schedule.timezone??'UTC';
  let formatter=formatters.get(timezone);if(!formatter){formatter=new Intl.DateTimeFormat('en-US',{timeZone:timezone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'});formatters.set(timezone,formatter);}
  const start=Math.floor(after/minuteMs)*minuteMs+minuteMs,end=start+5*366*dayMs;
  // Search local dates, rather than formatting millions of UTC minutes for rare schedules.
  for(let date=localParts(after,formatter).date;date<end+dayMs;date+=dayMs){
    const calendarDate=new Date(date),dayMatches=cron.day.has(calendarDate.getUTCDate()),weekMatches=cron.weekday.has(calendarDate.getUTCDay());
    const calendar=cron.anyDay||cron.anyWeekday?dayMatches&&weekMatches:dayMatches||weekMatches;
    if(!cron.month.has(calendarDate.getUTCMonth()+1)||!calendar)continue;
    const offsets=new Set<number>(timezone==='UTC'?[0]:[]);
    // Both sides of an offset transition are needed for missing/repeated local hours.
    if(timezone!=='UTC')for(let sample=date-2*dayMs;sample<=date+2*dayMs;sample+=6*60*minuteMs){
      const parts=localParts(sample,formatter);offsets.add(parts.date+parts.hour*60*minuteMs+parts.minute*minuteMs-sample);
    }
    const candidates=new Set<number>();
    for(const hour of cron.hour)for(const minute of cron.minute)for(const offset of offsets){
      const time=date+hour*60*minuteMs+minute*minuteMs-offset;if(time>=start&&time<end)candidates.add(time);
    }
    for(const time of [...candidates].sort((a,b)=>a-b)){
      const parts=localParts(time,formatter);
      if(parts.date===date&&cron.hour.has(parts.hour)&&cron.minute.has(parts.minute))return new Date(time).toISOString();
    }
  }
  throw new Error('Cron schedule has no occurrence in the next five years');
}
