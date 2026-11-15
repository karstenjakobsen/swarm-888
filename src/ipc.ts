import { EventEmitter } from 'node:events';
import { connect as connectSocket, type Socket } from 'node:net';
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { connectorSnapshotSchema } from './connectors/schemas.ts';

export const workerEventSchema = z.object({ cursor: z.number().int().positive(), runId: z.string(), type: z.string(), data: z.unknown(), createdAt: z.string() });
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export const runtimeOperationSchema=z.object({id:z.string().min(1).max(150),method:z.string().min(1).max(100),status:z.enum(['running','uncertain']),requiresExternalInspection:z.boolean()}).strict();
export type RuntimeOperation=z.infer<typeof runtimeOperationSchema>;
export const workerHealthSchema = z.object({
  connected: z.literal(true), uid: z.number().int(), pid: z.number().int(), root: z.boolean(),
  executionUid:z.number().int().nonnegative().optional(),sourceProtected:z.boolean().optional(),
  runtime: z.object({ available: z.boolean(), version: z.string(), authenticated: z.boolean(), authenticating: z.boolean().optional(), detail: z.string(), model: z.string().optional() }),
  activeRunId: z.string().nullable(), uncertainRuns: z.array(z.string()), replacementReserved: z.boolean().optional(),
  runtimeOperations:z.array(runtimeOperationSchema).max(1000).optional(),
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;
export const submitSchema = z.object({
  runId: z.string().min(1).max(150).regex(/^[a-zA-Z0-9_-]+$/), conversationId: z.string().min(1).max(150).regex(/^[a-zA-Z0-9_-]+$/), threadId: z.string().nullable().optional(),
  prompt: z.string().min(1).max(200_000), cwd: z.string().startsWith('/'), bootstrap: z.string().max(40_000),
  skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), path: z.string().startsWith('/'), version: z.union([z.string(), z.number()]) })).max(100),
  connectors:z.array(connectorSnapshotSchema).max(20).optional(),
  kind: z.enum(['user', 'improvement']).optional(), timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
});
export type Submission = z.infer<typeof submitSchema>;
export const checkSkillSchema = z.object({
  candidatePath: z.string().startsWith('/'),
  checks: z.array(z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()),
    fixtures: z.record(z.string(), z.string()), expectedStdout: z.string().optional(), expectedFiles: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })).min(1).max(20),
});
export const rpcEnvelopeSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).passthrough().optional() });

/** JSONL framing with a hard input cap; shared by both sides of the private socket. */
export function readFrames(socket: Socket, receive: (frame: z.infer<typeof rpcEnvelopeSchema>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { socket.destroy(new Error('IPC frame exceeds 16 MiB')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { receive(rpcEnvelopeSchema.parse(JSON.parse(line))); }
      catch { socket.destroy(new Error('Invalid IPC message')); return; }
    }
  });
}

/** Controller client. Closing a connection never interrupts a worker run. */
export class WorkerClient extends EventEmitter {
  private socket?: Socket;
  private serial = 0;
  private pending = new Map<number, { socket: Socket; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<WorkerHealth>;
  constructor(private config: Config) { super(); }

  async connect(): Promise<WorkerHealth> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return workerHealthSchema.parse(await this.request('health', {}));
    this.connecting = this.open();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }
  private async open(): Promise<WorkerHealth> {
    const stat = lstatSync(this.config.socketPath);
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || stat.uid !== this.config.controllerUid) throw new Error('Worker socket must be a mode 0600 Unix socket owned by the controller UID');
    const socket = connectSocket(this.config.socketPath); this.socket = socket;
    socket.on('error', () => {});
    socket.on('close', () => {
      const current = this.socket === socket;
      if (current) this.socket = undefined;
      for (const [id, request] of this.pending) {
        if (request.socket !== socket) continue;
        clearTimeout(request.timer); this.pending.delete(id); request.reject(new Error('Worker disconnected; execution may continue'));
      }
      if (current) this.emit('disconnect');
    });
    readFrames(socket, frame => {
      if (frame.method === 'event') { const parsed = workerEventSchema.safeParse(frame.params); if (parsed.success) this.emit('event', parsed.data); else socket.destroy(); return; }
      if (typeof frame.id !== 'number') return;
      const pending = this.pending.get(frame.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { socket.off('connect', connected); socket.off('error', failed); socket.off('close', closed); };
        const connected = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const closed = () => { cleanup(); reject(new Error('Worker disconnected before connecting')); };
        socket.once('connect', connected); socket.once('error', failed); socket.once('close', closed);
      });
      return workerHealthSchema.parse(await this.request('hello', { token: this.config.ipcToken }));
    } catch (error) { socket.destroy(); throw error; }
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('Worker is disconnected'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const frame = JSON.stringify({ id, method, params }) + '\n';
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Worker ${method} timed out; outcome may be uncertain`)); }, method === 'checkSkill' ? 600_000 : method==='managed/deploy'?180_000:method==='managed/prepare'?60_000:30_000);
      this.pending.set(id, { socket, resolve, reject, timer });
      try { socket.write(frame); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(): void { this.socket?.destroy(); }
}
