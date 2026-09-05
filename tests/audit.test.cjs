const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../public/app.js','utf8');
function render(raw){
  const el={textContent:raw,title:'',getAttribute:()=>raw,setAttribute(){}};
  const context={document:{getElementById:()=>null,querySelectorAll:()=>[el],body:{addEventListener(){},classList:{toggle(){}}}},window:{addEventListener(){}},setInterval(){},setTimeout(){},fetch:async()=>({ok:false}),Date,console};
  vm.runInNewContext(source,context);
  return el;
}
test('audit visibly includes historical day, year and UTC, not time only',()=>{
  for(const iso of ['2022-06-14T10:20:30Z','2023-12-31T23:59:59Z','2024-01-01T00:00:00Z','2024-02-29T00:00:00Z','1970-01-01T00:00:00Z']){
    assert.equal(render(String(Date.parse(iso)/1000)).textContent,iso.replace('T',' ').replace('Z',' UTC'));
  }
});
test('invalid audit timestamps do not fabricate a date',()=>{
  for(const raw of ['',null,'garbage','123junk','1.5','Infinity','8640000000001','  ']) assert.equal(render(raw).textContent,'Unknown timestamp');
});
