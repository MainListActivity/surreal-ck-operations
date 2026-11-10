// 仅由 demo/server.ts 的构建别名加载，生产构建不引用此模块。
export const CALLBACK_PATH='/demo-login';
const key='sck.design.logged-in';
export async function beginLogin(origin:string){sessionStorage.setItem(key,'yes');return origin+'/?design-login='+crypto.randomUUID()+'#board';}
export async function completeLogin(){return {ok:true} as const;}
export async function accessToken(){return sessionStorage.getItem(key)==='yes'?'local-demo-only':undefined;}
export function clearSession(){sessionStorage.removeItem(key);}
export const signOutLocal=clearSession;
export type Fetcher=(input:string,init?:RequestInit)=>Promise<Response>;

export const LOGIN_LABEL="进入本地设计预览";
export const LOGIN_HINT="使用静态示例数据，无需账号，不连接身份服务或生产库。";
