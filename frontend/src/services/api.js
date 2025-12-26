const BASE = 'http://localhost:5000';
async function request(path, init) {
    const res = await fetch(BASE + path, {
        headers: { 'Content-Type': 'application/json' },
        ...init
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    return res.json();
}
export const api = {
    execute(action, body = {}) {
        return request('/api/execute', {
            method: 'POST',
            body: JSON.stringify({ action, ...body })
        });
    },
    screenshot() {
        return request('/api/screenshot');
    },
    health() {
        return request('/api/health');
    }
};
//# sourceMappingURL=api.js.map