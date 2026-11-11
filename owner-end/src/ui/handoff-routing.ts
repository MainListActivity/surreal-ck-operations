export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface HandoffRoute {
  points: Point[];
  path: string;
  /** 标签中心；没有足够空白时不返回，调用方不应强行放到线中央。 */
  label?: Point;
}

interface RouteInput {
  from: Rect;
  to: Rect;
  bounds: Rect;
  obstacles: Rect[];
  labelSize?: { width: number; height: number };
}

const CLEARANCE = 6;
const BEND_COST = 18;
const EPSILON = 1e-7;
type Axis = 0 | 1;
interface Port { point: Point; exit: Point; axis: Axis }
interface SearchItem { state: number; cost: number; estimate: number }

const valid = (r: Rect) => [r.left, r.top, r.right, r.bottom].every(Number.isFinite) && r.right > r.left && r.bottom > r.top;
const grow = (r: Rect): Rect => ({left:r.left-CLEARANCE, top:r.top-CLEARANCE, right:r.right+CLEARANCE, bottom:r.bottom+CLEARANCE});
const inside = (p: Point, r: Rect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const overlap = (a: Rect, b: Rect) => a.left < b.right-EPSILON && a.right > b.left+EPSILON && a.top < b.bottom-EPSILON && a.bottom > b.top+EPSILON;
const distance = (a: Point, b: Point) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);

function clearSegment(a: Point, b: Point, obstacles: Rect[]): boolean {
  if (a.y === b.y) {
    const left = Math.min(a.x,b.x), right = Math.max(a.x,b.x);
    return !obstacles.some(r => a.y > r.top+EPSILON && a.y < r.bottom-EPSILON && left < r.right-EPSILON && right > r.left+EPSILON);
  }
  if (a.x === b.x) {
    const top = Math.min(a.y,b.y), bottom = Math.max(a.y,b.y);
    return !obstacles.some(r => a.x > r.left+EPSILON && a.x < r.right-EPSILON && top < r.bottom-EPSILON && bottom > r.top+EPSILON);
  }
  return false;
}

function ports(rect: Rect, bounds: Rect, obstacles: Rect[]): Port[] {
  const result: Port[] = [];
  // 中点优先；消息/人物挡住中点时可沿同一侧调整，不能穿过端点人物逃逸。
  for (const fraction of [.5,.25,.75]) {
    const x = rect.left+(rect.right-rect.left)*fraction;
    const y = rect.top+(rect.bottom-rect.top)*fraction;
    const candidates: Port[] = [
      {point:{x:rect.left,y},exit:{x:rect.left-CLEARANCE,y},axis:0},
      {point:{x:rect.right,y},exit:{x:rect.right+CLEARANCE,y},axis:0},
      {point:{x,y:rect.top},exit:{x,y:rect.top-CLEARANCE},axis:1},
      {point:{x,y:rect.bottom},exit:{x,y:rect.bottom+CLEARANCE},axis:1},
    ];
    result.push(...candidates.filter(p => inside(p.point,bounds) && inside(p.exit,bounds) && clearSegment(p.point,p.exit,obstacles)));
  }
  return result;
}

function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last?.x === point.x && last.y === point.y) continue;
    while (result.length >= 2) {
      const a = result.at(-2)!, b = result.at(-1)!;
      if ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y)) result.pop();
      else break;
    }
    result.push(point);
  }
  return result;
}

function labelPosition(points: Point[], size: RouteInput['labelSize'], bounds: Rect, obstacles: Rect[]): Point | undefined {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return;
  const segments = points.slice(1).map((b,i) => ({a:points[i]!,b,length:distance(points[i]!,b)})).sort((a,b) => b.length-a.length);
  for (const {a,b} of segments) {
    for (const fraction of [.5,.25,.75]) {
      const point = {x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction};
      const box = {left:point.x-size.width/2,right:point.x+size.width/2,top:point.y-size.height/2,bottom:point.y+size.height/2};
      if (box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom && !obstacles.some(r => overlap(box,r))) return point;
    }
  }
}

class Queue {
  private values: SearchItem[] = [];
  get length() { return this.values.length; }
  push(item: SearchItem) {
    let index = this.values.length;
    this.values.push(item);
    while (index > 0) {
      const parent = (index-1)>>1;
      if (this.values[parent]!.estimate <= item.estimate) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = item;
  }
  pop(): SearchItem {
    const first = this.values[0]!, last = this.values.pop()!;
    if (!this.values.length) return first;
    let index = 0;
    while (index*2+1 < this.values.length) {
      let child = index*2+1;
      if (child+1 < this.values.length && this.values[child+1]!.estimate < this.values[child]!.estimate) child++;
      if (this.values[child]!.estimate >= last.estimate) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

/**
 * 在房间坐标内找正交空白通道。所有视觉障碍留 6px 间距；from/to 也不可被穿越。
 * 人物与端点重叠时仍保留人物障碍，找不到出口/通道就返回 undefined。
 * 只惰性展开障碍边缘坐标，不创建完整网格或对每对出口重复搜索。
 */
export function routeHandoff(input: RouteInput): HandoffRoute | undefined {
  const {from,to,bounds,labelSize} = input;
  if (![from,to,bounds].every(valid)) return;
  const obstacles = input.obstacles.filter(valid).map(grow).filter(r => overlap(r,bounds));
  const fromBox = grow(from), toBox = grow(to);
  const sources = ports(from,bounds,[...obstacles,toBox]);
  const targets = ports(to,bounds,[...obstacles,fromBox]);
  if (!sources.length || !targets.length) return;
  const blocked = [...obstacles,fromBox,toBox];
  const finish = (points: Point[]): HandoffRoute => {
    const reduced = simplify(points);
    const label = labelPosition(reduced,labelSize,bounds,blocked);
    return {points:reduced,path:reduced.map((p,i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '),...(label ? {label} : {})};
  };

  // 常见同排无遮挡交接直接返回，避免为简单关系运行搜索。
  let straight: {source:Port;target:Port;length:number} | undefined;
  for (const source of sources) for (const target of targets) {
    if (source.axis !== target.axis || (source.axis === 0 ? source.exit.y !== target.exit.y : source.exit.x !== target.exit.x)) continue;
    const length = distance(source.point,target.point);
    if ((!straight || length < straight.length) && clearSegment(source.exit,target.exit,blocked)) straight = {source,target,length};
  }
  if (straight) return finish([straight.source.point,straight.source.exit,straight.target.exit,straight.target.point]);

  const unique = (values: number[]) => [...new Set(values)].sort((a,b) => a-b);
  const xs = unique([bounds.left,bounds.right,...sources.map(p => p.exit.x),...targets.map(p => p.exit.x),...blocked.flatMap(r => [r.left,r.right]).filter(x => x >= bounds.left && x <= bounds.right)]);
  const ys = unique([bounds.top,bounds.bottom,...sources.map(p => p.exit.y),...targets.map(p => p.exit.y),...blocked.flatMap(r => [r.top,r.bottom]).filter(y => y >= bounds.top && y <= bounds.bottom)]);
  const width = xs.length;
  const xIndex = new Map(xs.map((x,i) => [x,i])), yIndex = new Map(ys.map((y,i) => [y,i]));
  const nodeOf = (p: Point) => yIndex.get(p.y)!*width+xIndex.get(p.x)!;
  const pointOf = (node: number): Point => ({x:xs[node%width]!,y:ys[Math.floor(node/width)]!});
  const goals = new Map<number,Port[]>();
  for (const target of targets) {
    const node = nodeOf(target.exit);
    goals.set(node,[...(goals.get(node) ?? []),target]);
  }
  const heuristic = (point: Point) => Math.min(...targets.map(p => distance(point,p.exit)))+CLEARANCE;
  const queue = new Queue();
  const costs = new Map<number,number>(), previous = new Map<number,number>(), origin = new Map<number,Port>();
  const edgeClear = new Map<number,boolean>();
  for (const source of sources) {
    const state = nodeOf(source.exit)*2+source.axis;
    if (costs.has(state)) continue;
    costs.set(state,CLEARANCE);
    origin.set(state,source);
    queue.push({state,cost:CLEARANCE,estimate:CLEARANCE+heuristic(source.exit)});
  }
  let best: {state:number;target:Port;cost:number} | undefined;
  while (queue.length) {
    const item = queue.pop();
    if (best && item.estimate >= best.cost) break;
    if (item.cost !== costs.get(item.state)) continue;
    const node = Math.floor(item.state/2), axis = item.state%2;
    const point = pointOf(node), column = node%width, row = Math.floor(node/width);
    for (const target of goals.get(node) ?? []) {
      const cost = item.cost+CLEARANCE+(axis === target.axis ? 0 : BEND_COST);
      if (!best || cost < best.cost) best = {state:item.state,target,cost};
    }
    const neighbors: Array<[number,Axis]> = [];
    if (column > 0) neighbors.push([node-1,0]);
    if (column+1 < width) neighbors.push([node+1,0]);
    if (row > 0) neighbors.push([node-width,1]);
    if (row+1 < ys.length) neighbors.push([node+width,1]);
    for (const [next,nextAxis] of neighbors) {
      // 相邻节点的无向边以较小节点和方向编码，反向探索共用碰撞结果。
      const key = Math.min(node,next)*2+nextAxis;
      let clear = edgeClear.get(key);
      const nextPoint = pointOf(next);
      if (clear === undefined) {
        clear = clearSegment(point,nextPoint,blocked);
        edgeClear.set(key,clear);
      }
      if (!clear) continue;
      const state = next*2+nextAxis;
      const cost = item.cost+distance(point,nextPoint)+(axis === nextAxis ? 0 : BEND_COST);
      if (cost >= (costs.get(state) ?? Infinity)) continue;
      costs.set(state,cost);
      previous.set(state,item.state);
      origin.set(state,origin.get(item.state)!);
      queue.push({state,cost,estimate:cost+heuristic(nextPoint)});
    }
  }
  if (!best) return;
  const points = [best.target.point];
  let state: number | undefined = best.state;
  while (state !== undefined) {
    points.push(pointOf(Math.floor(state/2)));
    state = previous.get(state);
  }
  points.push(origin.get(best.state)!.point);
  return finish(points.reverse());
}
