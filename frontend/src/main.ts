import { api } from './services/api';
import { wsClient, WsPayload } from './services/websocket';
import './styles.css';

const chatLog = document.getElementById('chat-log') as HTMLDivElement;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const screenshotImg = document.getElementById('browser-screenshot') as HTMLImageElement;
const placeholder = document.getElementById('browser-placeholder') as HTMLDivElement;
const takeScreenshotBtn = document.getElementById('take-screenshot-btn') as HTMLButtonElement;
const generateScriptBtn = document.getElementById('generate-script-btn') as HTMLButtonElement | null;
const closeSessionBtn = document.getElementById('close-session-btn') as HTMLButtonElement;
const seleniumCodeContainer = document.getElementById('selenium-code-container') as HTMLDivElement | null;
const seleniumCodeOutput = document.getElementById('selenium-code-output') as HTMLPreElement | null;
const copySeleniumCodeBtn = document.getElementById('copy-selenium-code-btn') as HTMLButtonElement | null;
const wsStatusDot = document.getElementById('ws-status-dot');
const wsStatusText = document.getElementById('ws-status-text');

function setWsStatus(state: 'connected' | 'disconnected' | 'error', label: string) {
  if (!wsStatusDot || !wsStatusText) return;
  wsStatusDot.classList.remove('connected', 'disconnected', 'error');
  wsStatusDot.classList.add(state);
  wsStatusText.textContent = label;
}

function appendLog(p: WsPayload | { type: string; message: string; timestamp?: string; role?: 'user' }) {
  const entry = document.createElement('div');
  entry.className = `chat-entry ${p.type} ${'role' in p ? p.role : 'system'}`;
  const ts = document.createElement('span');
  ts.className = 'timestamp';
  ts.textContent = (p as any).timestamp
    ? new Date((p as any).timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const msg = document.createElement('span');
  msg.className = 'message';
  msg.textContent = p.message;
  entry.appendChild(ts);
  entry.appendChild(msg);
  chatLog.appendChild(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
}

wsClient.on((p) => {
  if (p.type === 'log') setWsStatus('connected', 'Connected');
  if (p.type === 'error') setWsStatus('error', 'Error');
  appendLog(p);
});

wsClient.connect();

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;

  appendLog({ type: 'info', message: text, role: 'user' });
  promptInput.value = '';

  const isUrl = /^https?:\/\//i.test(text);
  const action = isUrl ? 'navigate' : 'ai'; // use AI brain for natural language commands

  try {
    const res = await api.execute(action, isUrl ? { url: text } : { prompt: text });
    if (res.screenshot) {
      screenshotImg.src = res.screenshot;
      screenshotImg.hidden = false;
      placeholder.hidden = true;
    }
    // Any navigation or AI action switches the preview back to screenshot mode.
    if (seleniumCodeContainer && seleniumCodeOutput) {
      seleniumCodeContainer.hidden = true;
      seleniumCodeOutput.textContent = '';
    }
  } catch (err: any) {
    appendLog({ type: 'error', message: err.message ?? String(err) });
  }
});

takeScreenshotBtn.addEventListener('click', async () => {
  try {
    const res = await api.screenshot();
    if (res.screenshot) {
      screenshotImg.src = res.screenshot;
      screenshotImg.hidden = false;
      placeholder.hidden = true;
    }
    if (seleniumCodeContainer && seleniumCodeOutput) {
      seleniumCodeContainer.hidden = true;
      seleniumCodeOutput.textContent = '';
    }
  } catch (err: any) {
    appendLog({ type: 'error', message: err.message ?? String(err) });
  }
});

if (generateScriptBtn && seleniumCodeContainer && seleniumCodeOutput) {
  generateScriptBtn.addEventListener('click', async () => {
    try {
      const res = await api.execute('generate_selenium');
      if (res.seleniumCode) {
        seleniumCodeOutput.textContent = res.seleniumCode;
        seleniumCodeContainer.hidden = false;
        // When showing the script, hide the screenshot so the code is immediately visible.
        screenshotImg.hidden = true;
        placeholder.hidden = true;
      } else {
        seleniumCodeOutput.textContent = '# No Selenium script could be generated (no recorded steps).';
        seleniumCodeContainer.hidden = false;
      }
    } catch (err: any) {
      appendLog({ type: 'error', message: err.message ?? String(err) });
    }
  });
}

if (copySeleniumCodeBtn && seleniumCodeOutput) {
  copySeleniumCodeBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(seleniumCodeOutput.textContent ?? '');
    } catch (err) {
      console.error('Failed to copy selenium code', err);
    }
  });
}

closeSessionBtn.addEventListener('click', () => {
  // you can add /api/close if needed
  location.reload();
});
