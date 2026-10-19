export type ReaTool = { name: string; description?: string; inputSchema: Record<string, any>; available?: boolean; reason?: string; reasonCode?: string; remediation?: string; kind?: string; upstreamAvailability?: Record<string, any>; readinessEvidence?: string };
export type EngineEvent = { type: 'log' | 'status' | 'progress'; text?: string; stream?: string; timestamp: string; [key: string]: unknown };
export type Target = { id: string; path: string; name: string; kind: 'file' | 'directory'; size?: number };
export type EngineStatus = { connected: boolean; version?: string; toolCount: number; busy: boolean; target?: Target; tools: ReaTool[]; outputDirectory?: string; error?: string };
export type ReaResult = { content?: Array<{ type: string; text?: string; [key: string]: unknown }>; structuredContent?: any; isError?: boolean; [key: string]: any };
export type ResultDescription = { analysisVersion: number; language: string; summary: string; purpose: string; observations: Array<{ line: number; text: string; explanation: string }>; functions: Array<{ name: string; line: number; explanation: string }>; dependencies: string[]; limitations: string[] };
export type ResultFile = { id: string; caseId: string; name: string; filename: string; targetName: string; targetPath: string; sourcePath: string; storedPath: string; bytes: number; sha256: string; kind: 'recovered-file' | 'pseudocode' | 'assembly' | 'source'; savedAt: string; operation: string; evidenceId?: string; description: ResultDescription };
export type ProviderSettingId = 'ghidra' | 'hopper' | 'ida' | 'jadx' | 'java' | 'adb' | 'apktool' | 'pwntools' | 'wakaru' | 'binwalk' | 'unblob' | 'browser';
export type ProviderSetting = { id: ProviderSettingId; label: string; path: string; kind: 'file' | 'directory'; environmentKey: string; description: string; overridden: boolean };
export interface ReaBridge {
  status(): Promise<EngineStatus>;
  connect(): Promise<EngineStatus>;
  doctor(): Promise<any>;
  chooseTarget(kind: 'file' | 'directory'): Promise<Target | null>;
  chooseDroppedTarget?(file: File): Promise<Target | null>;
  chooseToolInput?(input: { name: string; key: string; kind: 'file' | 'directory' }): Promise<string | null>;
  openTarget(input: { targetId: string; providerId?: string; maxHeapMb?: number }): Promise<ReaResult>;
  callTool(input: { name: string; arguments: Record<string, any> }): Promise<ReaResult>;
  cancel(): Promise<void>;
  reset?(): Promise<void>;
  previewDossier?(): Promise<{ path: string; markdown: string } | null>;
  exportDossier(): Promise<{ path: string; markdown: string } | null>;
  exportPdf?(): Promise<{ path: string } | null>;
  readArtifact(path: string): Promise<{ path: string; text: string }>;
  listResults?(): Promise<ResultFile[]>;
  readResult?(id: string): Promise<{ file: ResultFile; text?: string; truncated: boolean }>;
  importResults?(): Promise<{ saved: number; warnings: string[] } | null>;
  exportResults?(input?: { targetPath?: string }): Promise<{ path: string; count: number } | null>;
  copyText?(text: string): Promise<void>;
  mcpConfig(): Promise<{ transport: string; configuration: Record<string, any>; description: string }>;
  providerSettings?(): Promise<ProviderSetting[]>;
  chooseProviderSetting?(id: string): Promise<ProviderSetting[] | null>;
  clearProviderSetting?(id: string): Promise<ProviderSetting[]>;
  onEvent(callback: (event: EngineEvent) => void): () => void;
}
declare global { interface Window { reaWorkbench?: ReaBridge } }
