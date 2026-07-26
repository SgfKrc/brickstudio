// 后端模型库 API(零依赖本地服务)。无后端时自动降级到 localStorage。
export const api = {
  available: null,

  async detect() {
    try {
      const r = await fetch('api/ping', { cache: 'no-store' });
      this.available = r.ok;
    } catch {
      this.available = false;
    }
    return this.available;
  },

  async list() {
    const r = await fetch('api/models');
    return r.ok ? r.json() : [];
  },

  async load(name) {
    const r = await fetch('api/models/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('模型不存在');
    return r.text();
  },

  async save(name, text) {
    const r = await fetch('api/models/' + encodeURIComponent(name), { method: 'PUT', body: text });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '保存失败');
  },

  async remove(name) {
    await fetch('api/models/' + encodeURIComponent(name), { method: 'DELETE' });
  },

  saveAuto(text) {
    if (this.available) fetch('api/autosave', { method: 'PUT', body: text }).catch(() => {});
    else try { localStorage.setItem('bs-autosave', text); } catch { /* 忽略 */ }
  },

  async loadAuto() {
    if (this.available) {
      try {
        const r = await fetch('api/autosave');
        return r.ok ? await r.text() : null;
      } catch { return null; }
    }
    try { return localStorage.getItem('bs-autosave'); } catch { return null; }
  },
};
