// Kickoff capacity planner: per-person capacity vs carry-in vs what's loaded in the next sprint.
//
// Answers "how should we reshape the next sprint so it fills each person's remaining gap?"
//   capacity = mean points COMPLETED per sprint over a recent window
//   carry-in  = their not-complete points in the closing sprint
//   gap       = capacity - carry-in  (how much NEW work they can take)
//
// CAVEAT: the per-sprint completion figures below count tickets by CURRENT status and sprint
// membership, so a ticket carried across three sprints counts in all three. That inflates
// historical columns (checked 2026-09-02: this method gave 165/162/168 where the tool reported
// 91/94/76). For a trustworthy capacity basis, use the date-window method instead — first
// done-transition inside the sprint window, INCLUSIVE end date, deduped by most-complete
// changelog. See reference/keen-sprint-report.md in the remindme store.
//
// Written ad hoc 2026-09-02 for the Sprint 36 kickoff; kept because the carry-in and
// loaded-next-sprint halves are correct and reusable. Sprint IDs are hardcoded — update them.
import { jiraFetch } from '/Users/mjg/code/keen-sprint-report/src/jira.js';
import { isComplete } from '/Users/mjg/code/keen-sprint-report/src/status.js';
const SPRINTS=[[3298,'31'],[3299,'32'],[3464,'33'],[3563,'34'],[3332,'35']];
const S36=3564;
const pts=i=>typeof i.fields.customfield_10023==='number'?i.fields.customfield_10023:0;
const who=i=>(i.fields.assignee?.displayName||'unassigned');
async function issues(id){
  let out=[],startAt=0;
  while(true){ const d=await jiraFetch(`/rest/agile/1.0/sprint/${id}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,assignee,customfield_10023`);
    out.push(...d.issues); startAt+=d.issues.length; if(startAt>=d.total||!d.issues.length) break; }
  return out;
}
// completed points per person per sprint (current status; fine for closed sprints)
const done={}, sprintTot={};
for(const [id,nm] of SPRINTS){
  const iss=await issues(id);
  for(const i of iss){ if(!isComplete(i.fields.status.name)) continue;
    const w=who(i); (done[w] ||= {}); done[w][nm]=(done[w][nm]||0)+pts(i); }
  sprintTot[nm]=iss.filter(i=>isComplete(i.fields.status.name)).reduce((a,i)=>a+pts(i),0);
}
// carry-in to 36 = not-complete in 35
const s35=await issues(3332), carry={};
for(const i of s35){ if(isComplete(i.fields.status.name)) continue; carry[who(i)]=(carry[who(i)]||0)+pts(i); }
// already loaded in 36 (excluding anything also in 35, which is carryover not new)
const in35=new Set(s35.map(i=>i.key));
const s36=await issues(S36), loaded={};
for(const i of s36){ if(in35.has(i.key)) continue; loaded[who(i)]=(loaded[who(i)]||0)+pts(i); }

// Roster is derived from whoever actually appears as an assignee in the analysed sprints,
// rather than hardcoded — this repo is public, and it keeps the list from going stale.
const ROSTER = [...new Set([...Object.keys(done), ...Object.keys(carry), ...Object.keys(loaded)])]
  .filter((n) => n !== 'unassigned')
  .sort((a, b) => {
    const mean = (p) => { const v = SPRINTS.map(([, nm]) => done[p]?.[nm] || 0); return v.reduce((x, y) => x + y, 0) / v.length; };
    return mean(b) - mean(a);
  })
console.log(`${'person'.padEnd(20)}${'31'.padStart(4)}${'32'.padStart(4)}${'33'.padStart(4)}${'34'.padStart(4)}${'35'.padStart(4)}${'CAP'.padStart(7)}${'carry-in'.padStart(10)}${'headroom'.padStart(10)}${'loaded36'.padStart(10)}`);
console.log('-'.repeat(83));
let capT=0,carT=0,loadT=0,headT=0;
for(const p of ROSTER){
  const v=SPRINTS.map(([,nm])=>done[p]?.[nm]||0);
  const cap=v.reduce((a,b)=>a+b,0)/v.length;
  const c=carry[p]||0, l=loaded[p]||0, h=cap-c;
  capT+=cap; carT+=c; loadT+=l; if(h>0) headT+=h;
  console.log(`${p.slice(0,19).padEnd(20)}`+v.map(x=>String(x).padStart(4)).join('')+`${cap.toFixed(1).padStart(7)}${(c+'p').padStart(10)}${(h>=0?'+':'')+h.toFixed(1)+'p'.padStart(1)}`.padEnd(10)+`${(l+'p').padStart(10)}`);
}
console.log('-'.repeat(83));
console.log(`${'TOTAL'.padEnd(20)}`+SPRINTS.map(([,nm])=>String(sprintTot[nm]).padStart(4)).join('')+`${capT.toFixed(0).padStart(7)}${(carT+'p').padStart(10)}${('+'+headT.toFixed(0)+'p').padStart(10)}${(loadT+'p').padStart(10)}`);
console.log(`\nunassigned loaded in 36: ${loaded['unassigned']||0}p   |   unassigned carrying in: ${carry['unassigned']||0}p`);
