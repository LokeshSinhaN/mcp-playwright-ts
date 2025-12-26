export interface ExecutionResult {
  success: boolean;
  message: string;
  screenshot?: string;
  seleniumCode?: string;
  selectors?: any[];
  error?: string;
  data?: unknown;
}

const BASE = 'http://localhost:5000';

async function request(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  execute(action: string, body: Record<string, unknown> = {}) {
    return request('/api/execute', {
      method: 'POST',
      body: JSON.stringify({ action, ...body })
    }) as Promise<ExecutionResult>;
  },
  screenshot() {
    return request('/api/screenshot') as Promise<ExecutionResult>;
  },
  health() {
    return request('/api/health') as Promise<{ success: boolean; browserOpen: boolean }>;
  }
};
