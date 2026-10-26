#!/usr/bin/env node
/** Dependency-free checks for this handoff's supplied schemas and data.
 * Supports every schema keyword used here; not a general JSON Schema library.
 * The app must still use its full JSON Schema 2020-12 validator (e.g. Ajv 2020). */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const original = read('data/training-pack.v1.json');
const baseline = read('data/training-pack.v2.json');
const v1schema = read('contracts/training-pack.schema.json');
const v2schema = read('contracts/training-pack.v2.schema.json');
const v3schema = read('contracts/training-pack.v3.schema.json');
const input = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root,'data/training-pack.v3.json');
const pack = JSON.parse(fs.readFileSync(input,'utf8'));
const canonical = x => JSON.stringify(x && typeof x === 'object' ? Array.isArray(x) ? x.map(y=>JSON.parse(canonical(y))) : Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])) : x);
function structural(value, rule, schema, at='$') {
  if (rule.$ref) {
    let target = schema;
    for (const k of rule.$ref.slice(2).split('/')) target = target[k];
    assert(target, `${at}: unresolved schema ref`);
    return structural(value,target,schema,at);
  }
  if (rule.anyOf) {
    const ok = rule.anyOf.some(x=> {try {structural(value,x,schema,at);return true;} catch{return false;}});
    assert(ok,`${at}: no anyOf branch matches`);return;
  }
  if (rule.enum) assert(rule.enum.some(x=>canonical(x)===canonical(value)),`${at}: enum`);
  if (rule.type==='null') {assert(value===null,`${at}: null`);return;}
  if (rule.type==='boolean') {assert(typeof value==='boolean',`${at}: boolean`);return;}
  if (rule.type==='integer') {
    assert(Number.isInteger(value),`${at}: integer`);
    assert(value >= (rule.minimum??-Infinity) && value <= (rule.maximum??Infinity),`${at}: numeric bounds`);return;
  }
  if (rule.type==='string') {
    assert(typeof value==='string',`${at}: string`);
    assert(value.length >= (rule.minLength??0) && value.length <= (rule.maxLength??Infinity),`${at}: string length`);
    if(rule.pattern) assert(new RegExp(rule.pattern).test(value),`${at}: pattern`);
    if(rule.format==='date') assert(/^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value,`${at}: date`);
    return;
  }
  if (rule.type==='object') {
    assert(value && typeof value==='object' && !Array.isArray(value),`${at}: object`);
    for(const k of rule.required??[]) assert(Object.hasOwn(value,k),`${at}: missing ${k}`);
    for(const [k,v] of Object.entries(value)) {
      if(!Object.hasOwn(rule.properties??{},k)) {assert(rule.additionalProperties!==false,`${at}: unknown ${k}`);continue;}
      structural(v,rule.properties[k],schema,`${at}.${k}`);
    } return;
  }
  if (rule.type==='array') {
    assert(Array.isArray(value),`${at}: array`);
    assert(value.length >= (rule.minItems??0) && value.length <= (rule.maxItems??Infinity),`${at}: array length`);
    for(let i=0;i<value.length;i++) {
      if(i<(rule.prefixItems?.length??0)) structural(value[i],rule.prefixItems[i],schema,`${at}[${i}]`);
      else {assert(rule.items!==false,`${at}: extra array entry`);if(rule.items && typeof rule.items==='object')structural(value[i],rule.items,schema,`${at}[${i}]`);}
    }
  }
}
function index(xs,label) {
  const m=new Map();for(const x of xs){assert(!m.has(x.id),`${label}: duplicate ${x.id}`);m.set(x.id,x);}return m;
}
function noUnsafeText(x,where='$') {
  if(typeof x==='string') {
    if(where.endsWith('.url')) return; // Separately checked as the exact YouTube watch URL.
    assert(!/[<=]/.test(x) && !/javascript:/i.test(x),`${where}: unsafe text`);
  } else if(Array.isArray(x)) x.forEach((v,i)=>noUnsafeText(v,`${where}[${i}]`));
  else if(x && typeof x==='object') for(const [k,v] of Object.entries(x)) {
    assert(!['password','passwordHash','username','massGrams'].includes(k),`${where}: personal field`);noUnsafeText(v,`${where}.${k}`);
  }
}
function check(p) {
  structural(p,v3schema,v3schema);
  assert(Buffer.byteLength(JSON.stringify(p)) <= 2*1024*1024,'file size');
  noUnsafeText(p);
  assert(p.packId===baseline.packId && p.version===baseline.version+1,'pack identity/version');
  const es=index(p.exercises,'exercises'),vs=index(p.videos,'videos'),ps=index(p.plans,'plans'),gs=index(p.programs,'programs');
  assert.deepEqual([...ps.keys()].sort(),['arms','chest','core','legs'],'exactly four active plans');
  for(const v of vs.values()) {
    assert(v.url===`https://www.youtube.com/watch?v=${v.youtubeId}`,'video URL');
    assert(!['PQ-F5uzxipQ','oLu9kwDzBdg'].includes(v.youtubeId),'known unavailable video remains');
  }
  for(const e of es.values()) {
    assert(vs.has(e.videoId),`exercise ${e.id}: video`);
    const n=e.defaultImplementCount,b=e.defaultLoadBasis;
    assert(b==='per_dumbbell' ? [1,2].includes(n) : ['single_dumbbell','barbell_total','external_total'].includes(b) ? n===1 : n===0,`load count ${e.id}`);
    assert(e.metric==='duration' ? e.repsMeaning==='seconds' : e.laterality==='separate_sides' ? e.repsMeaning==='per_side' : ['simultaneous_repetitions','alternating_total'].includes(e.repsMeaning),`rep semantics ${e.id}`);
  }
  const occurrenceIds=new Set();
  for(const p of ps.values()) {
    assert(!p.archived && vs.has(p.exampleVideoId) && vs.has(p.warmup.videoId),'plan selectable/videos');
    for(const range of [p.estimatedDurationMinutes,p.warmup.durationMinutes,p.cooldown.durationMinutes])assert(range[0]<=range[1],'duration order');
    const work=index(p.items,`${p.id} work`);
    for(const [section,items] of [['warmup',p.warmup.steps],['workout',p.items],['cooldown',p.cooldown.steps]]) {
      for(const i of items) {
        assert(!occurrenceIds.has(i.id),`global duplicate occurrence ${i.id}`);occurrenceIds.add(i.id);
        const e=es.get(i.exerciseId);assert(e && i.exerciseVersion===e.version,`${i.id}: exercise/version`);
        assert(i.target.metric===e.metric && i.target.perSide===(e.laterality==='separate_sides'),`${i.id}: target semantics`);
        assert(i.restAfter===(i.target.perSide?'both_sides':'set'),`${i.id}: rest sides`);
        assert(i.target.min<=i.target.max,`${i.id}: range order`);
        if(section==='workout') {
          assert(i.optional===false,'no automatically gated optional work');
          assert(e.metric==='duration' ? i.targetRir===null : i.targetRir && i.targetRir[0]<=i.targetRir[1],`${i.id}: effort`);
        } else {
          assert((section==='warmup'?['pulse_raise','mobility','rehearsal']:['easy_movement','stretch']).includes(i.role),`${i.id}: section role`);
          if(i.linkedWorkoutItemId!==null) {
            const w=work.get(i.linkedWorkoutItemId);
            assert(i.role==='rehearsal' && w && w.exerciseId===i.exerciseId && w.exerciseVersion===i.exerciseVersion,`${i.id}: rehearsal link`);
          }
        }
      }
    }
  }
  const blockIds=new Set();let blockCount=0,logicalSets=0,actualRows=0;
  const expected={arms:[3,16,19],chest:[3,12,15],legs:[3,13,17],core:[2,12,16]};
  for(const plan of ps.values()) {
    const items=new Map(plan.items.map(i=>[i.id,i]));
    const flattened=[];let logical=0,rows=0;
    assert.equal(plan.version,expected[plan.id][0],'plan version');
    for(const b of plan.workoutBlocks) {
      assert(!blockIds.has(b.id) && !occurrenceIds.has(b.id),'duplicate/colliding block ID');blockIds.add(b.id);blockCount++;
      assert(b.itemIds.length>=2 && b.itemIds.length<=3,'group must contain 2-3 exercises in this pack');
      for(const id of b.itemIds) {
        assert(items.has(id),'dangling block member');assert(!flattened.includes(id),'duplicate block member');flattened.push(id);
        const item=items.get(id);assert.equal(item.workingSets,b.rounds,'rounds must equal prescribed sets');
        logical+=b.rounds;rows+=b.rounds*(item.target.perSide?2:1);
      }
      // Exercise one exact execution sequence. This is one set per member/round,
      // never rounds times workingSets. Only ONE rest boundary is emitted.
      const events=[];
      for(let round=1;round<=b.rounds;round++) for(let j=0;j<b.itemIds.length;j++) {
        const type=j<b.itemIds.length-1?'exercise':round<b.rounds?'round':'block';
        const seconds=type==='exercise'?b.restBetweenExercisesSeconds:type==='round'?b.restBetweenRoundsSeconds:b.restAfterBlockSeconds;
        events.push({round,itemId:b.itemIds[j],type,seconds});
      }
      assert.equal(events.length,b.rounds*b.itemIds.length,'duplicated execution visits');
      assert.equal(events.filter(e=>e.type==='round').length,b.rounds-1,'round timer boundaries');
      assert.equal(events.filter(e=>e.type==='block').length,1,'block timer boundaries');
    }
    assert.deepEqual(flattened,plan.items.map(i=>i.id),'every item once in execution order');
    assert.equal(plan.workoutBlocks.at(-1).restAfterBlockSeconds,0,'last workout block has no further work rest');
    assert.equal(logical,expected[plan.id][1],'logical set allocation');assert.equal(rows,expected[plan.id][2],'side row allocation');
    logicalSets+=logical;actualRows+=rows;
  }
  assert.equal(blockCount,10,'ten blocks');
  assert.equal(canonical(p.programs),canonical(baseline.programs),'fixed program unchanged');
  assert.equal(canonical(p.videos),canonical(baseline.videos),'videos unchanged');
  assert(gs.size===1 && gs.has('return-to-training'),'one stable program');
  for(const g of gs.values()) {
    assert(g.phases.length===1,'no phased progression');const ph=g.phases[0];
    assert.deepEqual(ph.weeks,[1,null]);assert(ph.workingSetCap===null && ph.allowOptional===false,'fixed prescription');
    const schedule=ph.schedule??g.schedule;assert(schedule?.length===4,'four scheduled workouts');
    assert(new Set(schedule.map(s=>s.weekday)).size===schedule.length,'unique weekdays');
    for(const s of schedule)assert(ps.has(s.planId),'scheduled plan missing');
  }
  for(const name of ['exercises','plans','programs']) {
    const old=index(baseline[name],`old ${name}`);const current=index(p[name],`new ${name}`);
    for(const [id,e] of current) {
      if(!old.has(id))continue;const prev=old.get(id);
      if(e.version===prev.version)assert.equal(canonical(e),canonical(prev),`${name} ${id}: changed same version`);
      else assert(e.version>prev.version,`${name} ${id}: version regression`);
      if(name==='exercises')for(const k of ['metric','laterality','repsMeaning','defaultLoadBasis'])assert.equal(e[k],prev[k],`immutable semantic ${id}/${k}`);
    }
    if(name==='exercises')for(const [id,e] of old)assert.equal(canonical(current.get(id)),canonical(e),`reused exercise changed ${id}`);
  }
  return {blocks:blockCount,logicalWorkingSets:logicalSets,actualWorkingRows:actualRows,plans:ps.size,exercises:es.size,videos:vs.size,programs:gs.size,sectionSteps:p.plans.reduce((n,p)=>n+p.warmup.steps.length+p.cooldown.steps.length,0),workItems:p.plans.reduce((n,p)=>n+p.items.length,0)};
}
structural(original,v1schema,v1schema);
structural(baseline,v2schema,v2schema);
assert.throws(()=>structural(pack,v1schema,v1schema),'v1 must reject new format');
assert.throws(()=>structural(pack,v2schema,v2schema),'v2 must reject new format');
const result=check(pack);
const negativeTests=[
 ['missing workout blocks',p=>{delete p.plans[0].workoutBlocks;}],
 ['dangling block member',p=>{p.plans[0].workoutBlocks[0].itemIds[0]='not-a-work-item';}],
 ['duplicate block member',p=>{p.plans[0].workoutBlocks[1].itemIds[0]=p.plans[0].workoutBlocks[0].itemIds[0];}],
 ['missing block membership',p=>{p.plans[0].workoutBlocks.pop();}],
 ['reordered block members',p=>{p.plans[0].workoutBlocks[0].itemIds.reverse();}],
 ['round count disagrees with sets',p=>{p.plans[0].workoutBlocks[0].rounds=4;}],
 ['fractional round count',p=>{p.plans[0].workoutBlocks[0].rounds=2.5;}],
 ['negative rest',p=>{p.plans[0].workoutBlocks[0].restBetweenRoundsSeconds=-5;}],
 ['duplicate block id',p=>{p.plans[0].workoutBlocks[1].id=p.plans[0].workoutBlocks[0].id;}],
 ['same-version grouped plan edit',p=>{p.plans[0].version=2;}],
 ['extra final work rest',p=>{p.plans[0].workoutBlocks.at(-1).restAfterBlockSeconds=120;}],

 ['unknown field',p=>{p.plans[0].cooldown.extra='bad';}],
 ['missing cooldown exercise',p=>{p.plans[0].cooldown.steps[0].exerciseId='missing-exercise';}],
 ['wrong exercise version',p=>{p.plans[0].warmup.steps[0].exerciseVersion=999;}],
 ['duplicate occurrence',p=>{p.plans[0].cooldown.steps[0].id=p.plans[0].warmup.steps[0].id;}],
 ['incorrect laterality',p=>{p.plans[0].items[0].target.perSide=false;}],
 ['bad rehearsal link',p=>{p.plans[0].warmup.steps[5].linkedWorkoutItemId=p.plans[0].items[1].id;}],
 ['same-version definition edit',p=>{p.exercises[0].cues[0]='Changed';}],
 ['wrong total-count meaning',p=>{p.exercises.find(e=>e.id==='alternating-heel-touches').repsMeaning='per_side';}],
 ['markup in note',p=>{p.plans[0].notes[0]='a < b';}],
 ['private calf video',p=>{const v=p.videos.find(v=>v.id==='v-calf');v.youtubeId='PQ-F5uzxipQ';v.url=`https://www.youtube.com/watch?v=${v.youtubeId}`;}],
 ['reintroduced phase cap',p=>{p.programs[0].phases[0].workingSetCap=1;}],
];
for(const [label,mutate] of negativeTests){const clone=structuredClone(pack);mutate(clone);assert.throws(()=>check(clone),{name:'AssertionError'},label);}
console.log(JSON.stringify({status:'PASS',...result,unchangedExistingExercises:baseline.exercises.length,negativeTests:negativeTests.length,v1Compatibility:'PASS',v2Compatibility:'PASS',v3RejectedByOlderSchemas:'PASS',checks:'Supplied schema constraints, block membership, round/side allocation, timer boundaries, reference integrity and immutable versions'},null,2));
