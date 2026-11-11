import { DemoRuntime } from './runtime.ts';
import { isReadOnlyCommand } from '../src/command-effects.ts';
import { resolve } from 'node:path';
import { DemoStore, DemoError } from './store.ts';
import { parseSnapshot, withDesignCases, DESIGN_TAG } from './data.ts';

export const CSP="default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const root=resolve(import.meta.dir,'..');
const legacyImages=new Map([
  ['/people/team-atlas.png','/people/team-atlas.4e778a21bb0b.webp'],
  ['/people/meeting-room.png','/people/meeting-room.587f3ad68e38.webp'],
  ['/people/office-closeup.png','/people/office-closeup.78cbb5a011ed.webp'],
]);
export async function buildDemo(){
  const result=await Bun.build({entrypoints:[resolve(root,'src/ui/main.tsx')],target:'browser',jsx:{importSource:'preact'},plugins:[{name:'local-design-auth',setup(build){build.onResolve({filter:/^\.\/auth\.ts$/},args=>args.importer.includes('/src/ui/')?{path:resolve(import.meta.dir,'auth.ts')}:undefined);}}]});
  if(!result.success)throw Error(result.logs.map(String).join('\n'));
  return result.outputs[0]!;
}
export function handler(store:DemoStore,origin:string,build=buildDemo){
  const runtime=new DemoRuntime(store);
  const peers=new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encode=new TextEncoder();
  const notify=()=>{for(const peer of peers)try{peer.enqueue(encode.encode('event: change\ndata: {"tables":["*"]}\n\n'));}catch{peers.delete(peer);}};
  // 单次到期推进本地模拟并主动推送；不依靠页面轮询，也不访问生产。
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAdvance=()=>{
    clearTimeout(advanceTimer);
    const due=[...store.timers].filter(([id])=>store.data.requirements.find(r=>r.id===id)?.state!=='paused').map(([,at])=>at);
    if(!due.length)return;
    advanceTimer=setTimeout(()=>{store.tick();notify();scheduleAdvance();},Math.max(0,Math.min(...due)-Date.now()));
    advanceTimer.unref?.();
  };
  const events=(signal:AbortSignal)=>{let peer:ReadableStreamDefaultController<Uint8Array>;let heartbeat:ReturnType<typeof setInterval>|undefined;const cleanup=()=>{clearInterval(heartbeat);peers.delete(peer);signal.removeEventListener('abort',close);};const close=()=>{cleanup();try{peer.close();}catch{}};
    return new Response(new ReadableStream<Uint8Array>({start(c){peer=c;peers.add(c);signal.addEventListener('abort',close,{once:true});c.enqueue(encode.encode('event: ready\ndata: {"tables":["*"]}\n\n'));heartbeat=setInterval(()=>{try{peer.enqueue(encode.encode('event: heartbeat\ndata: {}\n\n'));}catch{close();}},20_000);if(signal.aborted)close();},cancel:cleanup}),{headers:{'content-type':'text/event-stream'}});
  };
  const json=(result:unknown,status=200)=>Response.json(result,{status});
  const allowedOrigins=new Set([origin]);
  if(process.env.FIGMA){
    const port=new URL(origin).port;
    allowedOrigins.add(`http://localhost:${port}`);
    if(process.env.FIGMA_PUBLIC_URL)allowedOrigins.add(new URL(process.env.FIGMA_PUBLIC_URL).origin);
  }
  return async(request:Request):Promise<Response>=>{
    const url=new URL(request.url);
    let response:Response;
    if(!allowedOrigins.has(url.origin))return new Response('仅允许本机设计环境访问',{status:403});
    if(request.headers.get('origin')&&!allowedOrigins.has(request.headers.get('origin')!))return new Response('不允许跨站请求',{status:403});
    try {
      if(request.method==='POST'){
        let changed=true;
        if(Number(request.headers.get('content-length')??0)>1_000_000)throw new DemoError('本地请求过大',413);
        const text=await request.text();if(text.length>1_000_000)throw new DemoError('本地请求过大',413);
        if(url.pathname==='/api/demo/reset'){runtime.reset();response=json({ok:true,result:store.reset()});}
        else if(url.pathname==='/api/demo/transfer'){runtime.transfer();response=json({ok:true});}
        else if(url.pathname==='/api/demo/crowd')response=json({ok:true,result:runtime.crowd()});
        else if(url.pathname==='/api/cmd'){
          const body=JSON.parse(text);if(typeof body.command!=='string')throw new DemoError('命令格式无效');
          response=json({ok:true,result:store.command(body.command,body.input??{})});
          changed=!isReadOnlyCommand(body.command);
        }else throw new DemoError('本地接口不存在',404);
        if(changed){notify();scheduleAdvance();}
      }else if(request.method!=='GET')throw new DemoError('不支持此方法',405);
      else if(url.pathname==='/api/me')response=json({ok:true,result:{sub:'设计预览',roles:['owner'],exp:Math.floor(Date.now()/1000)+86400}});
      else if(url.pathname==='/api/events')response=events(request.signal);
      else if(url.pathname==='/api/dashboard')response=json({ok:true,result:runtime.snapshot()});
      else if(url.pathname==='/api/board')response=json({ok:true,result:store.board()});
      else if(url.pathname==='/app.js')response=new Response(await build(),{headers:{'content-type':'text/javascript'}});
      else if(url.pathname==='/app.css')response=new Response(Bun.file(resolve(root,'public/app.css')));
      else if(legacyImages.has(url.pathname))response=new Response(null,{status:302,headers:{location:legacyImages.get(url.pathname)!}});
      else if(url.pathname==='/people/office-closeup.78cbb5a011ed.webp')response=new Response(Bun.file(resolve(root,'public/people/office-closeup.78cbb5a011ed.webp')));
      else if(url.pathname==='/people/meeting-room.587f3ad68e38.webp')response=new Response(Bun.file(resolve(root,'public/people/meeting-room.587f3ad68e38.webp')));
      else if(url.pathname==='/people/team-atlas.4e778a21bb0b.webp')response=new Response(Bun.file(resolve(root,'public/people/team-atlas.4e778a21bb0b.webp')),{headers:{'content-type':'image/webp'}});
      else if(url.pathname==='/demo.css')response=new Response('.design-banner{position:relative;z-index:30;padding:8px 20px;background:#fdf2de;color:#6b3f00;border-bottom:1px solid #efd29c;font:13px/1.5 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;display:flex;gap:6px 16px;align-items:center;flex-wrap:wrap}.design-banner strong{font-weight:600}.design-banner button{min-height:28px;padding:3px 12px;font-size:13px}',{headers:{'content-type':'text/css'}});
      else if(url.pathname==='/demo-controls.js')response=new Response("document.getElementById('demo-reset').onclick=async()=>{await fetch('/api/demo/reset',{method:'POST'});location.reload()}",{headers:{'content-type':'text/javascript'}});
      else if(url.pathname==='/'){
        const html=(await Bun.file(resolve(root,'public/index.html')).text()).replace('</head>','<link rel="stylesheet" href="/demo.css"></head>').replace('<body>','<body><aside class="design-banner"><strong>本地设计模式</strong><span>静态数据 · 不连接生产 · 操作仅在本地内存生效 · 标有'+DESIGN_TAG+'的记录为本地虚构示例</span><button id="demo-reset">重置示例数据</button></aside><script src="/demo-controls.js" defer></script>');
        response=new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});
      }else throw new DemoError('本地资源不存在',404);
    }catch(error){response=json({ok:false,error:{code:'demo_error',message:error instanceof DemoError?error.message:'本地请求或页面构建失败，请查看终端'}},error instanceof DemoError?error.status:400);}
    response.headers.set('content-security-policy',CSP);response.headers.set('cache-control','no-store');response.headers.set('x-content-type-options','nosniff');return response;
  };
}
if(import.meta.main){
  const args=process.argv.slice(2).filter(x=>x!=='--');
  const arg=(key:string)=>args[args.indexOf(key)+1];
  if(args.some((x,i)=>i%2===0&&!['--port','--snapshot','--cases'].includes(x))||args.length%2)throw Error('用法：pnpm demo [--port 6006] [--snapshot /绝对路径/design-snapshot.json] [--cases off]');
  const port=args.includes('--port')?Number(arg('--port')):6006;
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('端口必须为 1024–65535');
  const snapshotPath=args.includes('--snapshot')?resolve(arg('--snapshot')!):resolve(import.meta.dir,'production.snapshot.json');
  const file=Bun.file(snapshotPath);
  if(file.size>10_000_000)throw Error('快照超过 10 MB');
  const snapshot=parseSnapshot(await file.json());
  const data=arg('--cases')==='off'&&args.includes('--cases')?snapshot:withDesignCases(snapshot);
  await buildDemo();
  const origin=`http://127.0.0.1:${port}`;
  Bun.serve({hostname:'127.0.0.1',port,idleTimeout:0,maxRequestBodySize:1_000_000,fetch:handler(new DemoStore(data),origin)});
  console.log(`老板端设计模式：${origin}\n点击登录直接进入；刷新页面可查看代码/CSS 修改；重启或点击顶部按钮重置数据。\n数据来源：${data.source}${data===snapshot?'':`，另含本地设计案例（标注 ${DESIGN_TAG}，可用 --cases off 关闭）`}；产品 ${data.products.length}，需求 ${data.requirements.length}，任务 ${data.tasks.length}。`);
}
