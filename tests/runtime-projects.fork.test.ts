import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import { readRuntimeDashboard } from '../src/runtime-dashboard.ts';

const run = process.env.RUN_SCK_CHANNEL_FORK_TESTS === '1' ? test : test.skip;
run('真实公司 fork：读取长期阻塞员工及原因，不依赖近期事件窗口或尚存租约', async () => {
  const dir=mkdtempSync(join(tmpdir(),'runtime-rooms-fork-'));
  const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});
  const port=reservation.port!;reservation.stop(true);
  const child=Bun.spawn([join(homedir(),'.surrealdb/surreal'),'start','--bind',`127.0.0.1:${port}`,
    '--user','root','--pass','runtime-room-fixture','--log','error',`rocksdb:${dir}/db`],{stdout:'ignore',stderr:'ignore'});
  const db=new Surreal();
  try {
    let ready=false;
    for(let i=0;i<160;i++){
      try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    await db.connect(`ws://127.0.0.1:${port}/rpc`);
    await db.signin({username:'root',password:'runtime-room-fixture'});
    await db.query('DEFINE NAMESPACE rooms; USE NS rooms; DEFINE DATABASE fixture;');
    await db.use({namespace:'rooms',database:'fixture'});
    await db.query(`
      DEFINE TABLE company_meta SCHEMALESS;
      DEFINE TABLE outbound_message SCHEMALESS;
      DEFINE TABLE agent_policy SCHEMALESS;
      DEFINE TABLE requirement_execution SCHEMALESS;
      DEFINE TABLE acceptance_evidence SCHEMALESS;
      DEFINE TABLE agent_activity SCHEMALESS;
      DEFINE TABLE product_requirement SCHEMALESS;
      DEFINE TABLE requirement_plan SCHEMALESS;
      CREATE project:app SET name='测试项目';
      CREATE task:blocked SET title='缺少权限', state='blocked', project=project:app;
      CREATE outbound_message:execute SET task=task:blocked, state='sent', step='execute', sent_to='dev', sent_at=time::now()-1m;
      CREATE outbound_message:review SET task=task:blocked, state='sent', step='review', sent_to='reviewer', sent_at=time::now();
      CREATE employee:dev SET role='engineering', def=employee_def:engineering, session_task='blocked',
        last_task=task:blocked, runner_id='native:fixture', runtime_state='idle', runtime_at=time::now();
      CREATE runner_heartbeat:fixture SET runner='native:fixture',host='测试电脑',at=time::now();
      CREATE audit:blocked SET task=task:blocked,actor=employee:dev,action='block',
        evidence='缺少仓库权限；token=should-be-redacted',at=time::now()-40d;
      FOR $i IN 0..60 {
        CREATE audit SET task=task:other,actor=employee:other,action='checkpoint',evidence='更新进展',at=time::now();
      };
    `);
    const data=await readRuntimeDashboard(db);
    expect(data.events).toHaveLength(40);
    expect(data.events.some(e=>e.label==='报告阻塞')).toBe(false);
    const employee=data.agents.find(a=>a.id==='dev');
    expect(employee).toMatchObject({taskId:'blocked',taskState:'blocked',project:{id:'app',name:'测试项目'}});
    expect(employee?.blockedReason).toContain('缺少仓库权限');
    expect(employee?.blockedReason).not.toContain('should-be-redacted');
    expect(data.projects?.find(p=>p.id==='app')).toMatchObject({blocked:1,estimateReason:'存在阻塞'});
    expect(data.transfers.find(t=>t.taskId==='blocked')).toMatchObject({projectId:'app',from:'dev',to:'reviewer'});
  } finally {
    await db.close();child.kill();await child.exited;rmSync(dir,{recursive:true,force:true});
  }
},30000);
