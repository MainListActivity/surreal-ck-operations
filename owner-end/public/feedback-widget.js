// 通用产品反馈入口：<sck-feedback product="my-product" endpoint="https://company.maplayer.top" version="1.0"></sck-feedback>
// 不读取登录态、cookie 或本地存储，不自动采集页面内容，页面 URL 去掉查询串和 fragment。
class SckFeedback extends HTMLElement {
  connectedCallback(){
    if(this.shadowRoot)return;
    const root=this.attachShadow({mode:'open'});
    root.innerHTML=`<style>:host{font:14px system-ui;color:#17202a}button,input,textarea{font:inherit}button{padding:8px 12px;cursor:pointer}section{background:white;border:1px solid #ccd1d1;border-radius:8px;padding:16px;max-width:360px;box-shadow:0 4px 20px #0002}label{display:block;margin:10px 0}textarea,input{box-sizing:border-box;width:100%;padding:8px}textarea{min-height:100px}[hidden]{display:none}p{line-height:1.5}</style><button type="button" aria-expanded="false">意见反馈</button><section hidden><form><label>遇到了什么问题，或希望改进什么？<textarea required maxlength="6000"></textarea></label><label>联系方式（可选）<input maxlength="200" autocomplete="off"></label><p>仅提交你填写的内容、当前页面路径和产品版本。</p><button type="submit">提交反馈</button><button type="button" data-close>收起</button><p role="status" aria-live="polite"></p></form></section>`;
    const toggle=root.querySelector('button'),panel=root.querySelector('section'),form=root.querySelector('form'),status=root.querySelector('[role=status]'),submit=root.querySelector('[type=submit]');
    const close=()=>{panel.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();};
    toggle.addEventListener('click',()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)root.querySelector('textarea').focus();});
    root.querySelector('[data-close]').addEventListener('click',close);
    let requestKey=crypto.randomUUID(),previousBody='';
    form.addEventListener('submit',async event=>{
      event.preventDefault();submit.disabled=true;status.textContent='正在提交…';
      try{
        const endpoint=new URL(this.getAttribute('endpoint')||'https://company.maplayer.top');
        if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw new Error('反馈入口配置不正确');
        const product=this.getAttribute('product')||'';if(!/^[a-z][a-z0-9_-]{0,40}$/.test(product))throw new Error('反馈入口未配置产品');
        const fields={text:root.querySelector('textarea').value,contact:root.querySelector('input').value,page:location.origin+location.pathname,version:this.getAttribute('version')||''};
        const current=JSON.stringify(fields);if(previousBody&&previousBody!==current)requestKey=crypto.randomUUID();previousBody=current;
        const response=await fetch(new URL('/api/feedback/'+product,endpoint),{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify({...fields,requestKey}),signal:AbortSignal.timeout(20000)});
        const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error?.message||'提交失败，请稍后重试');
        status.textContent='反馈已收到，谢谢。';form.reset();requestKey=crypto.randomUUID();previousBody='';
        this.dispatchEvent(new CustomEvent('feedback-submitted',{detail:{id:result.result.id}}));
      }catch(error){status.textContent=error instanceof Error?error.message:'提交失败，请稍后重试';}finally{submit.disabled=false;}
    });
  }
}
if(!customElements.get('sck-feedback'))customElements.define('sck-feedback',SckFeedback);
