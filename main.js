// SHA-1 en JavaScript puro (no depende de crypto.subtle, que puede no existir en iOS)
function sha1Hex(bytes) {
  const ml = bytes.length;
  const withPad = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(withPad);
  buf.set(bytes);
  buf[ml] = 0x80;
  const bitLen = ml * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 4, bitLen >>> 0);
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
}
// Mismo hash que "git hash-object": sha1("blob <bytes>\0" + contenido)
function gitBlobSha(text) {
  const enc = new TextEncoder();
  const body = enc.encode(text);
  const head = enc.encode('blob ' + body.length + '\0');
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return sha1Hex(all);
}
const { Plugin, PluginSettingTab, Setting, Notice, Platform, MarkdownView } = require('obsidian');

const DIR = '99 Sistema/sync-journal';
const KEEP_DAYS = 30;            // diarios cerrados más antiguos se borran
const MAX_CHARS = 1500000;       // notas más grandes no se registran
const USER_WINDOW_MS = 4000;     // un guardado así de cerca de una pulsación es tuyo
const MAX_VERSIONS = 500;

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

module.exports = class SyncJournal extends Plugin {
  async onload() {
    this.sessions = new Map();   // ruta de nota -> sesión abierta
    this.lastEdit = new Map();   // ruta -> última pulsación (ms)
    this.starting = new Map();   // ruta -> promesa de inicio de sesión
    this.timers = new Map();     // ruta -> escritura diferida
    this.device = this.loadDevice();
    this.addSettingTab(new JournalSettings(this.app, this));
    this.addCommand({ id: 'estado', name: 'Ver notas registradas en este dispositivo', callback: () => {
      const n = this.sessions.size;
      new Notice(`Diario de sincronización (${this.device}): ${n} nota(s) en seguimiento.`);
    }});
    this.app.workspace.onLayoutReady(async () => {
      await this.restore();
      await this.prune();
      this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => this.onEditorChange(info)));
      this.registerEvent(this.app.vault.on('modify', f => this.onModify(f)));
      this.registerEvent(this.app.vault.on('rename', (f, oldPath) => this.closeSession(oldPath)));
      this.registerEvent(this.app.vault.on('delete', f => this.closeSession(f.path)));
    });
  }

  onunload() { for (const s of this.sessions.values()) this.flush(s); }

  // ---------- nombre del dispositivo (no se sincroniza: localStorage) ----------
  storageKey() { return 'boveda-sync-journal:' + this.app.vault.getName() + ':device'; }
  loadDevice() {
    let d = null;
    try { d = window.localStorage.getItem(this.storageKey()); } catch (e) {}
    return d || (Platform.isTablet ? 'ipad' : Platform.isPhone ? 'iphone' : 'pc');
  }
  saveDevice(name) {
    this.device = (name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || this.loadDevice();
    try { window.localStorage.setItem(this.storageKey(), this.device); } catch (e) {}
  }

  tracked(file) { return file && file.extension === 'md' && !file.path.startsWith(DIR + '/'); }
  journalPath(s) { return `${DIR}/${s.device}/${s.session}.json`; }

  // ---------- eventos ----------
  async onEditorChange(info) {
    const file = info && info.file;
    if (!this.tracked(file)) return;
    this.lastEdit.set(file.path, Date.now());
    if (this.sessions.has(file.path) || this.starting.has(file.path)) return;
    const p = this.startSession(file).finally(() => this.starting.delete(file.path));
    this.starting.set(file.path, p);
    await p;
  }

  async startSession(file) {
    // Se llama en la primera pulsación: el disco aún tiene la versión anterior = base.
    const content = await this.app.vault.read(file);
    if (content.length > MAX_CHARS) return;
    const sha = gitBlobSha(content);
    this.sessions.set(file.path, {
      v: 1, device: this.device, path: file.path, session: stamp(),
      started: new Date().toISOString(), updated: new Date().toISOString(), open: true,
      base_exists: true, base_sha: sha, base: content,
      versions: [], final_sha: sha, final: content,
    });
  }

  editorHas(path, content) {
    let same = false;
    this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
      const v = leaf.view;
      if (v instanceof MarkdownView && v.file && v.file.path === path && v.editor.getValue() === content) same = true;
    });
    return same;
  }

  async onModify(file) {
    if (!this.tracked(file)) return;
    if (this.starting.has(file.path)) await this.starting.get(file.path);
    const s = this.sessions.get(file.path);
    if (!s) return;
    const content = await this.app.vault.read(file);
    const sha = gitBlobSha(content);
    if (sha === s.final_sha) return;
    const recent = Date.now() - (this.lastEdit.get(file.path) || 0) < USER_WINDOW_MS;
    if (recent || this.editorHas(file.path, content)) {
      // Guardado tuyo: nueva versión de la sesión
      if (content.length > MAX_CHARS) return;
      s.versions.push(sha);
      if (s.versions.length > MAX_VERSIONS) s.versions = s.versions.slice(-MAX_VERSIONS);
      s.final = content; s.final_sha = sha; s.updated = new Date().toISOString();
      this.schedule(s);
    } else {
      // Cambio externo (lo ha bajado la sincronización): se cierra la sesión.
      // Su diario se queda: si tu versión se perdió, el NAS la recupera de ahí.
      await this.closeSession(file.path);
    }
  }

  async closeSession(path) {
    const s = this.sessions.get(path);
    if (!s) return;
    this.sessions.delete(path);
    s.open = false; s.updated = new Date().toISOString();
    await this.flush(s);
  }

  // ---------- escritura del diario ----------
  schedule(s) {
    clearTimeout(this.timers.get(s.path));
    this.timers.set(s.path, setTimeout(() => this.flush(s), 3000));
  }

  async flush(s) {
    clearTimeout(this.timers.get(s.path));
    this.timers.delete(s.path);
    if (!s.versions.length) return;            // no hubo cambios reales
    const adapter = this.app.vault.adapter;
    const dir = `${DIR}/${s.device}`;
    try {
      if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(this.journalPath(s), JSON.stringify(s));
    } catch (e) { console.error('Diario de sincronización: no se pudo escribir', e); }
  }

  // ---------- arranque y limpieza ----------
  async restore() {
    const adapter = this.app.vault.adapter, dir = `${DIR}/${this.device}`;
    if (!(await adapter.exists(dir))) return;
    const { files } = await adapter.list(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await adapter.read(f));
        if (!s.open) continue;
        const file = this.app.vault.getAbstractFileByPath(s.path);
        const now = file ? await this.app.vault.read(file) : null;
        // Si mientras Obsidian estaba cerrado la nota cambió, la sesión termina aquí.
        if (now !== null && gitBlobSha(now) === s.final_sha) this.sessions.set(s.path, s);
        else { s.open = false; s.updated = new Date().toISOString(); await adapter.write(f, JSON.stringify(s)); }
      } catch (e) {}
    }
  }

  async prune() {
    const adapter = this.app.vault.adapter, dir = `${DIR}/${this.device}`;
    if (!(await adapter.exists(dir))) return;
    const limit = Date.now() - KEEP_DAYS * 86400000;
    const { files } = await adapter.list(dir);
    for (const f of files) {
      try {
        const s = JSON.parse(await adapter.read(f));
        if (!s.open && Date.parse(s.updated) < limit) await adapter.remove(f);
      } catch (e) {}
    }
  }
};

class JournalSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Nombre de este dispositivo')
      .setDesc('Distinto en cada dispositivo (iphone, ipad...). Aparece en los conflictos para saber de dónde viene cada versión.')
      .addText(t => t.setValue(this.plugin.device).onChange(v => this.plugin.saveDevice(v)));
  }
}
