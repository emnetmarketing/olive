const test=require('node:test'),assert=require('node:assert/strict');
const {waitingForTargetDate}=require('../netlify/functions/trend-analysis-cache');
const job={mode:'instant',state:'running',targetDatePreflightEnabled:true,instantStateKey:'checkpoint',
 continuationDispatch:{ticket:'ticket'},targetDatePreflight:{status:'waiting',nextCheckAt:'2026-10-28T01:00:00Z',deadlineAt:'2026-10-28T14:59:59Z'}};
test('bounded scheduled target-date wait is not a stale worker',()=>{
 assert.equal(waitingForTargetDate(job,Date.parse('2026-10-28T00:00:00Z')),true);
 assert.equal(waitingForTargetDate(job,Date.parse('2026-10-28T01:11:00Z')),true);
 assert.equal(waitingForTargetDate(job,Date.parse('2026-10-28T01:13:00Z')),false);
});
test('missing checkpoint, deadline or deferred/completed Job cannot hold an active waiting lock',()=>{
 for(const patch of [{instantStateKey:null},{state:'deferred'},{state:'completed'},{mode:'period'},
  {targetDatePreflightEnabled:false},{targetDatePreflight:{...job.targetDatePreflight,deadlineAt:null}}])
  assert.equal(waitingForTargetDate({...job,...patch},Date.parse('2026-10-28T00:00:00Z')),false);
});
