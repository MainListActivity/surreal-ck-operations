/** Numeric stream observations only. This module never retains prompts or response text. */
export interface RequestMetrics {
  total_ms:number; ttft_ms?:number; first_text_ms?:number;
  output_tokens?:number; input_tokens?:number; cache_read_tokens?:number;
  reported_model?:string;
  /** Explicit upstream response declaration only; missing stays unknown. */
  reported_effort?:string;
}
const count=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export class StreamMetrics {
  private first?:number;private text?:number;private usage:Partial<RequestMetrics>={};
  private buffer='';private decoder=new TextDecoder();
  terminal=false;failed=false;
  constructor(private started:number,private now=Date.now){}
  private content(text:boolean){const at=this.now()-this.started;this.first??=at;if(text)this.text??=at;}
  private model(x:unknown){if(typeof x==='string'&&x.length<=300&&!x.startsWith('group/'))this.usage.reported_model=x;}
  private tokens(u:any){if(!u||typeof u!=='object')return;
    for(const [key,value] of Object.entries({output_tokens:u.output_tokens??u.completion_tokens,input_tokens:u.input_tokens??u.prompt_tokens,cache_read_tokens:u.cache_read_input_tokens??u.prompt_tokens_details?.cached_tokens}))if(count(value))(this.usage as any)[key]=value;
  }
  observe(event:any){
    if(!event||typeof event!=='object')return;
    if(event.error||event.type==='error'||event.type==='response.failed'||event.type==='response.incomplete')this.failed=true;
    if(event.type==='message_stop'||event.type==='response.completed')this.terminal=true;
    this.model(event.model??event.message?.model??event.response?.model);
    const envelope=event.message??event.response??event;
    const effort=envelope.output_config?.effort??envelope.reasoning?.effort??envelope.reasoning_effort;
    if (typeof effort === "string" && ["none","minimal","low","medium","high","xhigh","max","ultra"].includes(effort)) this.usage.reported_effort=effort;
    this.tokens(event.usage??event.message?.usage??event.response?.usage);
    const delta=event.delta;
    if(event.type==='content_block_start'){
      const b=event.content_block;
      if(b?.type==='tool_use')this.content(false);
      if(b?.type==='text'&&b.text)this.content(true);
      if(b?.type==='thinking'&&b.thinking)this.content(false);
    }
    if(event.type==='content_block_delta'){
      if(delta?.type==='text_delta'&&delta.text)this.content(true);
      else if((delta?.type==='thinking_delta'&&delta.thinking)||(delta?.type==='input_json_delta'&&delta.partial_json))this.content(false);
    }
    // OpenAI Chat Completions and Responses API.
    for(const c of event.choices??[]){const d=c.delta;
      if(d?.content)this.content(true);
      else if(d?.reasoning_content||d?.reasoning||d?.tool_calls?.length)this.content(false);
    }
    if(event.type==='response.output_text.delta'&&event.delta)this.content(true);
    else if((event.type?.startsWith('response.reasoning')||event.type==='response.function_call_arguments.delta')&&event.delta)this.content(false);
    if(event.type==='response.output_item.added'&&event.item?.type==='function_call')this.content(false);
  }
  feed(chunk:Uint8Array){
    this.buffer+=this.decoder.decode(chunk,{stream:true});let pos:number;
    while((pos=this.buffer.indexOf('\n'))>=0){this.line(this.buffer.slice(0,pos).trim());this.buffer=this.buffer.slice(pos+1);}
    // Do not hold arbitrarily large tool arguments or malformed event lines.
    if(this.buffer.length>1024*1024)this.buffer='';
  }
  private line(line:string){
    if(line==='event: error'){this.failed=true;return;}
    if(!line.startsWith('data:'))return;const data=line.slice(5).trim();
    if(data==='[DONE]'){this.terminal=true;return;}
    try{this.observe(JSON.parse(data));}catch{}
  }
  end(){this.buffer+=this.decoder.decode();if(this.buffer)this.line(this.buffer.trim());this.buffer='';}
  snapshot():RequestMetrics{return {...this.usage,total_ms:Math.max(0,this.now()-this.started),...(this.first!==undefined?{ttft_ms:this.first}:{}),...(this.text!==undefined?{first_text_ms:this.text}:{})};}
}
