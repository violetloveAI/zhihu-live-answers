import path from "node:path";
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { seedBaseWorkspaces } from "./seed";
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;
export type DbExecutor = AppDb;
export interface DatabaseHandle {
 db:AppDb; driver:"pglite"|"postgres";
 query<T extends Record<string,unknown> = Record<string,unknown>>(sql:string, params?:unknown[]):Promise<T[]>;
 transaction<T>(fn:(db:AppDb)=>Promise<T>):Promise<T>;
 close():Promise<void>;
}
export interface DatabaseOptions { databaseUrl?:string; dataDir?:string; seed?:boolean; migrationsFolder?:string }
function assertHostedDatabaseUrl(databaseUrl?:string):void {
 const host=process.env.RENDER === "true" ? "Render" : process.env.VERCEL === "1" ? "Vercel" : null;
 if (!host) return;
 let valid=false;
 try {
  const url=new URL(databaseUrl ?? "");
  valid=(url.protocol === "postgres:" || url.protocol === "postgresql:") && Boolean(url.hostname);
 } catch { /* The fixed error below must never include connection credentials. */ }
 if (!valid) throw new Error(`${host} requires a PostgreSQL DATABASE_URL (postgres:// or postgresql://); local PGlite storage is unavailable on ${host}.`);
}
export async function createDatabase(options:DatabaseOptions = {}):Promise<DatabaseHandle> {
 assertHostedDatabaseUrl(options.databaseUrl);
 const migrationOptions = { migrationsFolder: options.migrationsFolder ?? path.join(process.cwd(),"src/db/migrations") };
 let result:DatabaseHandle;
 if (options.databaseUrl) {
  const client=postgres(options.databaseUrl,{max:10,prepare:false});
  const nativeDb=drizzlePostgres(client,{schema});
  try { await migratePostgres(nativeDb,migrationOptions); } catch (error) { await client.end(); throw error; }
  const db=nativeDb as unknown as AppDb;
  result={db,driver:"postgres",query:async <T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) => Array.from(await client.unsafe(sql,params as never[])) as T[],transaction:fn=>db.transaction(tx=>fn(tx as unknown as AppDb)),close:()=>client.end()};
 } else {
  const dataDir=options.dataDir ?? path.join(/* turbopackIgnore: true */ process.cwd(),".data/live-answers");
  if (!dataDir.startsWith("memory://")) await mkdir(path.dirname(path.resolve(/* turbopackIgnore: true */ dataDir)),{recursive:true});
  const client=await PGlite.create(dataDir);
  const nativeDb=drizzlePglite(client,{schema});
  try { await migratePglite(nativeDb,migrationOptions); } catch (error) { await client.close(); throw error; }
  const db=nativeDb as unknown as AppDb;
  result={db,driver:"pglite",query:async <T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) => (await client.query<T>(sql,params)).rows,transaction:fn=>db.transaction(tx=>fn(tx as unknown as AppDb)),close:()=>client.close()};
 }
 try { if(options.seed !== false) await seedBaseWorkspaces(result.db); } catch(error) { await result.close(); throw error; }
 return result;
}
// Next dev reloads modules. A process-global promise also coalesces concurrent first reads.
const globalDb=globalThis as typeof globalThis & { __liveAnswersDatabases?:Map<string,Promise<DatabaseHandle>> };
export function getDatabase():Promise<DatabaseHandle> {
 const databaseUrl=process.env.DATABASE_URL?.trim();
 assertHostedDatabaseUrl(databaseUrl);
 const dataDir=process.env.DATA_DIR ? path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR) : path.join(/* turbopackIgnore: true */ process.cwd(),".data/live-answers");
 const key=databaseUrl ? `postgres:${databaseUrl}` : `pglite:${dataDir}`;
 const registry=globalDb.__liveAnswersDatabases ??= new Map();
 if (!registry.has(key)) {
  const promise=createDatabase({databaseUrl,dataDir}).then(handle=>{ const close=handle.close; handle.close=async()=>{registry.delete(key);await close();};return handle; });
  registry.set(key,promise);
  promise.catch(()=>registry.delete(key));
 }
 return registry.get(key)!;
}
export * as schema from "./schema";
