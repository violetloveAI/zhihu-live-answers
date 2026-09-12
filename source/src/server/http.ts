import { ZodError, type ZodType } from "zod";
import { DomainError } from "@/domain";
import { ProviderError } from "@/providers/contracts";

export function ok<T>(data:T, status=200) { return Response.json({data},{status,headers:{"Cache-Control":"no-store"}}); }
export async function input<T>(request:Request, schema:ZodType<T>):Promise<T> {
  if (Number(request.headers.get("content-length") ?? 0)>65536) throw new DomainError("body_too_large","内容太长，请缩短后再试。",413);
  const chunks:Uint8Array[]=[];let size=0;
  const reader=request.body?.getReader();
  if(reader)while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw new DomainError("body_too_large","内容太长，请缩短后再试。",413);}chunks.push(part.value);}
  const text=Buffer.concat(chunks).toString("utf8");
  let body:unknown;
  try { body=text.trim()?JSON.parse(text):{}; } catch { throw new DomainError("invalid_json","请求内容格式不正确。",400); }
  return schema.parse(body);
}
export function requestKey(request:Request):string {
  const key=request.headers.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9_.:-]{8,160}$/.test(key)) throw new DomainError("missing_idempotency_key","缺少请求标识，请刷新后再试。",400);
  return key;
}
export async function endpoint(action:()=>Promise<Response>):Promise<Response> {
  try { return await action(); }
  catch(error) {
    if(error instanceof ZodError) return Response.json({error:{code:"invalid_input",message:error.issues.map(i=>i.message).join("；"),retryable:false}},{status:400,headers:{"Cache-Control":"no-store"}});
    if(error instanceof ProviderError) {
      const status=({unconfigured:503,unsupported:503,unauthorized:502,rate_limited:429,timeout:504,invalid_response:422,unavailable:502,unknown_delivery:502} as const)[error.kind];
      return Response.json({error:{code:`provider_${error.kind}`,message:error.message,retryable:error.retryable}},{status,headers:{"Cache-Control":"no-store",...(error.retryAfterMs?{"Retry-After":String(Math.ceil(error.retryAfterMs/1000))}:{})}});
    }
    if(error instanceof DomainError || (error instanceof Error && "status" in error && "code" in error)) {
      const e=error as DomainError;
      return Response.json({error:{code:e.code,message:e.message,retryable:e.retryable??false}},{status:e.status??400,headers:{"Cache-Control":"no-store"}});
    }
    // Never return database queries, upstream bodies, session tokens or stack traces.
    console.error("[live-answers] request failed",error instanceof Error?error.name:"UnknownError");
    return Response.json({error:{code:"internal_error",message:"看山整理时遇到了一点问题，你的原答案仍然保留。请稍后重试。",retryable:true}},{status:500,headers:{"Cache-Control":"no-store"}});
  }
}
