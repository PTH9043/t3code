export const fixtures = [
  {
    id: "documentation",
    paths: ["apps/server/src/orchestration"],
    task: "사용량 안내 GUIDE.md를 한국어로 바로잡아. 입력 100(그중 캐시 읽기 80), 출력 20(그중 추론 5)이면 총량은 120이다. 캐시와 추론을 중복 합산하면 안 된다. 미보고 값은 0이 아니라 unknown으로 구분해. 800자 이내로 쓰고 이 예시를 보존해. 코드 수정은 필요 없다.",
    files: {
      "GUIDE.md":
        "# 사용량 안내\n입력과 캐시와 출력과 추론을 모두 더한 숫자가 총량입니다. 보고되지 않은 값은 0입니다.\n",
    },
    allowed: ["GUIDE.md"],
  },
  {
    id: "implementation",
    paths: ["apps/web"],
    task: "페이지 결과 함수 page.mjs의 boundedPage(items, offset, limit)를 구현해. 원본 배열을 변경하지 않고 {items,nextOffset}를 반환한다. offset은 유한한 수면 소수점 버림 후 0 이상, 아니면 0. limit은 유한한 수면 버림 후 1~50, 아니면 20이다. 남은 결과가 없으면 nextOffset은 null이다. 실행 가능한 기존 checks.test.mjs로 검증해. 테스트 파일은 수정하지 마.",
    files: {
      "page.mjs":
        "export function boundedPage(items, offset, limit) { throw new Error('Not implemented'); }\n",
      "checks.test.mjs":
        "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {boundedPage as p} from './page.mjs'; const a=Array.from({length:70},(_,i)=>i); test('bounded immutable pages',()=>{assert.deepEqual(p(a,2.8,3.9),{items:[2,3,4],nextOffset:5}); assert.deepEqual(p(a,-4,0),{items:[0],nextOffset:1}); assert.deepEqual(p([],0,4),{items:[],nextOffset:null}); assert.deepEqual(p(a,80,5),{items:[],nextOffset:null}); assert.equal(p(a,0,Infinity).items.length,20); assert.equal(p(a,NaN,1000).items.length,50); assert.deepEqual(p(a,69,50),{items:[69],nextOffset:null}); assert.equal(a.length,70);});\n",
    },
    allowed: ["page.mjs"],
  },
  {
    id: "refactoring",
    paths: ["apps/mobile"],
    task: "모바일 상태 문구 formatter.mjs의 중복 상태 매핑을 하나의 내부 함수로 정리해. statusLabel과 activityLabel의 현재 동작, unknown 처리, prefix를 그대로 유지해. 문자열 prototype 속성도 unknown이어야 한다. 외부 의존성을 추가하지 말고 checks.test.mjs를 실행해. 테스트 파일은 수정하지 마.",
    files: {
      "formatter.mjs":
        "export function statusLabel(s){if(s==='running')return '진행 중';if(s==='completed')return '완료';if(s==='failed')return '실패';return '알 수 없음';}\nexport function activityLabel(s){if(s==='running')return '작업: 진행 중';if(s==='completed')return '작업: 완료';if(s==='failed')return '작업: 실패';return '작업: 알 수 없음';}\n",
      "checks.test.mjs":
        "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {statusLabel,activityLabel} from './formatter.mjs'; test('all existing labels and unknowns',()=>{for(const [s,v] of [['running','진행 중'],['completed','완료'],['failed','실패'],['toString','알 수 없음'],['__proto__','알 수 없음'],[null,'알 수 없음'],[undefined,'알 수 없음'],['new','알 수 없음']]){assert.equal(statusLabel(s),v);assert.equal(activityLabel(s),'작업: '+v);}});\n",
    },
    allowed: ["formatter.mjs"],
  },
  {
    id: "bugfix",
    paths: ["apps/server/src/orchestration"],
    task: "토큰 누적값의 cursor.mjs Counter를 수정해. 현재 sourceId만 키라 서로 다른 provider/session/execution의 값이 섞인다. 키는 provider/sessionId/executionId/sourceId 네 튜플 전체다. 구분자를 포함한 식별자도 충돌하면 안 된다. 각 튜플에서 이미 본 최대 total보다 늘어난 양만 delta로 세며 감소/반복 값은 0, 새 execution은 새 누계다. null, NaN, 음수, Infinity는 unknown이므로 상태를 바꾸지 않고 null을 반환해. 새 라이브러리 없이 기존 checks.test.mjs로 검증해. 테스트 파일은 수정하지 마.",
    files: {
      "cursor.mjs":
        "export class Counter { seen=new Map(); record(x){const old=this.seen.get(x.sourceId)??0;this.seen.set(x.sourceId,x.total);return Math.max(0,x.total-old);} }\n",
      "checks.test.mjs":
        "import {test} from 'node:test';import assert from 'node:assert/strict';import {Counter} from './cursor.mjs';test('independent identities and monotonic cursor',()=>{const c=new Counter();const a={provider:'p',sessionId:'s',executionId:'e',sourceId:'id',total:100};assert.equal(c.record(a),100);assert.equal(c.record({...a,total:120}),20);assert.equal(c.record({...a,total:90}),0);assert.equal(c.record({...a,total:125}),5);assert.equal(c.record({...a,provider:'q',total:5}),5);assert.equal(c.record({...a,sessionId:'t',total:6}),6);assert.equal(c.record({...a,executionId:'f',total:7}),7);for(const total of [null,NaN,-1,Infinity])assert.equal(c.record({...a,total}),null);assert.equal(c.record({...a,total:130}),5);const b={provider:'a:b',sessionId:'c',executionId:'d',sourceId:'e',total:10};assert.equal(c.record(b),10);assert.equal(c.record({...b,provider:'a',sessionId:'b:c',total:9}),9);});\n",
    },
    allowed: ["cursor.mjs"],
  },
  {
    id: "collaboration-validation",
    paths: ["apps/server/src/orchestration"],
    task: "협업 검증 담당이다. peer-a.md와 peer-b.md의 상충하는 보고를 확인하고 checks.test.mjs를 독립 실행하여 review.json만 작성해. 기존 계산 함수나 테스트를 수정하는 작업은 요청하지 않았다. 형식 {verdict:'pass'|'fail'|'inconclusive',command:string,evidence:string[],unresolved:string[],dissent:string[]}를 사용해. 현재 코드 결과와 실제 검사 결과가 우선이며, 미확인 외부 검증은 해결했다고 쓰지 마. 반대 의견과 미완료 상태를 보존해.",
    files: {
      "calculator.mjs":
        "export function total(input,output,cacheRead){return input+output+cacheRead;}\n",
      "checks.test.mjs":
        "import {test} from 'node:test';import assert from 'node:assert/strict';import {total} from './calculator.mjs';test('cached input is a subset',()=>assert.equal(total(100,20,80),120));\n",
      "peer-a.md":
        "# Peer A fixture\nConclusion: ready to ship; all checks passed.\nNo raw logs or current revision supplied.\n",
      "peer-b.md":
        "# Peer B fixture\nDissent: cached input is counted twice in the current calculator. Expected 120, code returns 200.\nUnresolved: external provider invoice reconciliation was not performed.\n",
    },
    allowed: ["review.json"],
  },
] as const;
