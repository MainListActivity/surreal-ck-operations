import {expect,test} from 'bun:test';
import {routeHandoff,type Point,type Rect,type HandoffRoute} from '../src/ui/handoff-routing.ts';

const rect = (left:number,top:number,right:number,bottom:number):Rect => ({left,top,right,bottom});
const bounds = rect(0,0,600,400);
const from = rect(40,160,100,180);
const to = rect(480,160,540,180);

function assertClear(route:HandoffRoute|undefined, obstacles:Rect[], area = bounds) {
  expect(route).toBeDefined();
  const points = route!.points;
  expect(points.length).toBeGreaterThanOrEqual(2);
  for (const point of points) {
    expect(point.x).toBeGreaterThanOrEqual(area.left);
    expect(point.x).toBeLessThanOrEqual(area.right);
    expect(point.y).toBeGreaterThanOrEqual(area.top);
    expect(point.y).toBeLessThanOrEqual(area.bottom);
  }
  for (let i=1;i<points.length;i++) {
    const a=points[i-1]!,b=points[i]!;
    expect(a.x===b.x || a.y===b.y).toBe(true);
    for (const obstacle of obstacles) {
      const r=rect(obstacle.left-6,obstacle.top-6,obstacle.right+6,obstacle.bottom+6);
      const crosses = a.y===b.y
        ? a.y>r.top+1e-6 && a.y<r.bottom-1e-6 && Math.min(a.x,b.x)<r.right-1e-6 && Math.max(a.x,b.x)>r.left+1e-6
        : a.x>r.left+1e-6 && a.x<r.right-1e-6 && Math.min(a.y,b.y)<r.bottom-1e-6 && Math.max(a.y,b.y)>r.top+1e-6;
      expect(crosses).toBe(false);
    }
  }
}

test('无遮挡同排交接用端点边缘的短直线',()=>{
  const route=routeHandoff({from,to,bounds,obstacles:[]});
  assertClear(route,[]);
  expect(route!.points).toEqual([{x:100,y:170},{x:480,y:170}]);
  expect(route!.path).toBe('M100 170 L480 170');
});

test('绕开中间卡片，并为卡片保留 6px 间距',()=>{
  const obstacles=[rect(220,100,360,250)];
  const route=routeHandoff({from,to,bounds,obstacles});
  assertClear(route,obstacles);
  expect(route!.points.length).toBeGreaterThan(2);
  expect(route!.points.some(p=>p.y<=94 || p.y>=256)).toBe(true);
});

test('多个交错障碍也不能靠对角线穿越人物和消息',()=>{
  const obstacles=[rect(130,0,190,240),rect(240,170,300,400),rect(350,0,410,240)];
  const route=routeHandoff({from,to,bounds,obstacles});
  assertClear(route,obstacles);
  expect(route!.points.length).toBeGreaterThanOrEqual(8);
});

test('环与自己的形象重叠时从下沿离开，不排除端点人物障碍',()=>{
  const ownFrom=rect(60,110,120,130),ownTo=rect(380,110,440,130);
  const obstacles=[rect(50,30,130,120),rect(370,30,450,120),rect(50,145,140,200),rect(360,145,450,200)];
  const route=routeHandoff({from:ownFrom,to:ownTo,bounds,obstacles});
  assertClear(route,obstacles);
  expect(route!.points[0]!.y).toBe(130);
  expect(route!.points.at(-1)!.y).toBe(130);
});

test('端点完全被人物覆盖时不返回一条穿人物的兜底线',()=>{
  const obstacles=[rect(20,140,120,200)];
  expect(routeHandoff({from,to,bounds,obstacles})).toBeUndefined();
});

test('返工方向和上下布局保留真实起终点，通道可双向使用',()=>{
  const top=rect(260,30,300,70),bottom=rect(260,330,300,370);
  const obstacles=[rect(220,150,350,250)];
  for (const [source,target] of [[top,bottom],[bottom,top],[to,from]]) {
    const route=routeHandoff({from:source!,to:target!,bounds,obstacles});
    assertClear(route,obstacles);
    const start=route!.points[0]!,end=route!.points.at(-1)!;
    const onEdge=(p:Point,r:Rect)=>((p.x===r.left || p.x===r.right) && p.y>=r.top && p.y<=r.bottom) || ((p.y===r.top || p.y===r.bottom) && p.x>=r.left && p.x<=r.right);
    expect(onEdge(start,source!)).toBe(true);
    expect(onEdge(end,target!)).toBe(true);
  }
});

test('窄屏沿侧边通道绕过整块资料区，不越出房间',()=>{
  const area=rect(0,0,320,600),source=rect(130,30,190,70),target=rect(130,520,190,560);
  const obstacles=[rect(25,100,285,450)];
  const route=routeHandoff({from:source,to:target,bounds:area,obstacles});
  assertClear(route,obstacles,area);
  expect(route!.points.some(p=>p.x<=19 || p.x>=291)).toBe(true);
});

test('障碍横断全部房间时返回 undefined，不能越界或画直线兜底',()=>{
  expect(routeHandoff({from,to,bounds,obstacles:[rect(220,0,240,400)]})).toBeUndefined();
  expect(routeHandoff({from:rect(NaN,0,10,10),to,bounds,obstacles:[]})).toBeUndefined();
});

test('交接标签只在完整可容纳文字的空白处出现',()=>{
  const obstacles=[rect(220,100,360,250)];
  const size={width:100,height:28};
  const route=routeHandoff({from,to,bounds,obstacles,labelSize:size});
  assertClear(route,obstacles);
  // 绕障后的短侧边可能放不下标签；一旦返回，整块标签都必须避让。
  if (route!.label) {
    const {x,y}=route!.label;
    const box=rect(x-size.width/2,y-size.height/2,x+size.width/2,y+size.height/2);
    for (const r of [...obstacles,from,to]) expect(box.left<r.right+6 && box.right>r.left-6 && box.top<r.bottom+6 && box.bottom>r.top-6).toBe(false);
  }
  const clear=routeHandoff({from,to,bounds,obstacles:[],labelSize:size});
  expect(clear!.label).toEqual({x:290,y:170});
  expect(routeHandoff({from,to,bounds,obstacles:[],labelSize:{width:1000,height:1000}})!.label).toBeUndefined();
});

test('16 人的形象、消息与资料区之间仍能找到通道',()=>{
  const area=rect(0,0,1600,700);
  const obstacles:Rect[]=[],rings:Rect[]=[];
  for (let i=0;i<16;i++) {
    const x=25+(i%8)*195,y=20+Math.floor(i/8)*340;
    obstacles.push(rect(x+20,y+45,x+155,y+205),rect(x+5,y+5,x+170,y+33),rect(x+5,y+235,x+170,y+295));
    rings.push(rect(x+5,y+190,x+170,y+220));
  }
  for (const [a,b] of [[0,7],[7,0],[0,15],[8,12]]) {
    const route=routeHandoff({from:rings[a!]!,to:rings[b!]!,bounds:area,obstacles});
    assertClear(route,obstacles,area);
  }
});
