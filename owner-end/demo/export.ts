import { sanitize, type Row } from './data.ts';
// 仅由老板在生产老板端的开发者工具 Console 执行；不是设计模式依赖，不导出任何认证数据。
(async()=>{
  if(location.origin!=='https://company.maplayer.top')throw Error('请在生产老板端 https://company.maplayer.top 登录后执行。');
  const session=JSON.parse(sessionStorage.getItem('sck.owner.session')??'null');
  if(!session?.accessToken)throw Error('请先以老板身份登录。');
  const call=async(command:string,input:Row={})=>{
    const response=await fetch('/api/cmd',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+session.accessToken},body:JSON.stringify({command,input}),signal:AbortSignal.timeout(30000)});
    const body=await response.json();if(!response.ok||!body.ok)throw Error(`快照读取失败：${command}，HTTP ${response.status}。未生成不完整快照，请刷新登录后重试。`);return body.result;
  };
  const paged=async(command:string,key:string,limit:number,input:Row={})=>{const items:Row[]=[];for(let offset=0;offset<10000;offset+=limit){const batch=(await call(command,{...input,offset}))[key];if(!Array.isArray(batch))throw Error('快照响应格式错误');items.push(...batch);if(batch.length<limit)return items;}throw Error('记录过多，请按产品缩小导出范围');};
  const products=(await call('product.iteration.list')).products;
  const requirements=await paged('requirement.list','requirements',100);
  const feedback:Row[]=[];for(const project of products){feedback.push(...await paged('feedback.list','feedback',50,{project:project.id}));if(feedback.length>10000)throw Error('反馈总量超过 10000 条，请缩小导出范围');}
  const tasks=(await call('task.list')).tasks;
  const agents=(await call('agent.list')).agents;
  const notes=(await call('note.list')).notes;
  if(![products,requirements,feedback,tasks,agents,notes].every(Array.isArray))throw Error('快照响应字段不完整，未生成文件');
  const snapshot=sanitize({products,requirements,feedback,tasks,agents,notes});
  const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='owner-design-snapshot.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  console.info('脱敏设计快照已下载。真实正文、人员名称、ID、联系方式、URL 和凭证均未写入文件。');
})().catch(error=>console.error(error instanceof Error?error.message:'设计快照导出失败'));
