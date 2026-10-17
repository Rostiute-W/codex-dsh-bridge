import { z } from 'zod';

export const handoffSchema = z.object({
  requestId: z.string().min(8).max(160),
  title: z.string().min(1).max(160),
  repoPath: z.string().min(1).max(2000),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
  ready: z.literal(true),
  goal: z.string().min(10).max(16000),
  plan: z.string().min(20).max(64000),
  constraints: z.array(z.string().max(4000)).max(40),
  allowedPaths: z.array(z.string().min(1).max(1000)).min(1).max(80),
  validationCommands: z.array(z.string().min(1).max(4000)).min(1).max(20),
  acceptanceCriteria: z.array(z.string().min(1).max(4000)).min(1).max(40),
  commitMessage: z.string().min(8).max(180),
}).strict();
export type Handoff = z.infer<typeof handoffSchema>;
export const reviewSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  summary: z.string().min(1).max(16000),
  issues: z.array(z.string().max(8000)).max(50),
}).strict();
export type Review = z.infer<typeof reviewSchema>;
export const submitSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('execute'), handoff: handoffSchema }).strict(),
  z.object({ operation: z.literal('review'), taskId: z.string().uuid(), fingerprint: z.string().length(64), review: reviewSchema }).strict(),
  z.object({ operation: z.literal('revise'), taskId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('revalidate'), taskId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('resume'), taskId: z.string().uuid(), instruction: z.string().min(10).max(16000) }).strict(),
]);
export type Submit = z.infer<typeof submitSchema>;
export type Status = 'queued' | 'preparing' | 'running' | 'awaiting_permission' | 'validating' | 'awaiting_review' | 'review_running' | 'needs_changes' | 'committing' | 'completed' | 'failed' | 'cancelled' | 'needs_attention';
export const busyStatuses = new Set<Status>(['preparing', 'running', 'awaiting_permission', 'validating', 'review_running', 'committing']);
export interface Check { command: string; exitCode: number; output: string; at: string }
export interface Permission { id: string; title: string; detail: string; options: { id: string; name: string; kind: string }[] }
export const nativeModelSchema = z.object({
  provider: z.string().trim().min(1).max(300),
  model: z.string().trim().min(1).max(300),
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
}).strict();
export type NativeModel = z.infer<typeof nativeModelSchema>;
export const modelCatalogSchema = z.object({
  home: z.string(),
  default: nativeModelSchema,
  groups: z.array(z.object({
    id: z.string(), name: z.string(),
    models: z.array(z.object({
      id: z.string(), name: z.string(),
      reasoning: z.object({
        efforts: z.array(z.object({ id: z.string(), name: z.string() })),
        defaultEffort: z.string().optional(),
      }).optional(),
    })),
  })),
  failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export interface Task {
  id: string; handoff: Handoff; status: Status; createdAt: string; updatedAt: string;
  worktree?: string; branch?: string; sessionId?: string; capabilities?: unknown;
  executor?: 'desktop' | 'acp'; nativeCursor?: number;
  nativeModel?: NativeModel | null;
  nativeGuidance?: {seq:number;text:string}[];
  round: number; summary: string; error?: string; permission?: Permission;
  checks: Check[]; changedFiles: string[]; fingerprint?: string; diffPath?: string;
  review?: Review; reviewSource?: 'codex' | 'api'; apiUsage?: unknown;
  reviewedFingerprint?: string; commit?: string; commitStatus?: string;
  log: { at: string; kind: string; text: string }[];
}
export const settingsSchema = z.object({
  executionMode: z.enum(['desktop', 'acp']).default('desktop'),
  dshPath: z.string().min(1).max(2000),
  dshHome: z.string().max(2000).default(''),
  dshModel: z.string().max(300).default(''),
  nativeModel: nativeModelSchema.nullable().default(null),
  codexPath: z.string().min(1).max(2000),
  apiModel: z.string().max(200).default(''),
  timeoutMinutes: z.number().int().min(1).max(300),
  // Marks settings already upgraded from the old 30-minute default; absent means untouched legacy settings.
  timeoutDefaultVersion: z.literal(1).optional(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  executionMode: 'desktop',
  dshPath: 'E:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
  dshHome: '', dshModel: '', nativeModel: null, codexPath: 'codex', apiModel: '', timeoutMinutes: 300, timeoutDefaultVersion: 1,
};
export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
}
export function redact(text: string): string {
  return text.replace(/\b(?:sk|ds)[-_][a-zA-Z0-9_-]{16,}\b/g, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)([^\s,;]+)/gi, '$1[已隐藏凭据]');
}
export function validateReview(review: Review): Review {
  if (review.verdict === 'approved' && review.issues.length) throw new Error('通过审查不能同时包含待修复问题。');
  if (review.verdict === 'changes_requested' && !review.issues.length) throw new Error('要求修改时必须提供具体问题。');
  return review;
}
