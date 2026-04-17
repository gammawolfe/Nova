import { api, setToken, clearToken, getToken, onUnauthorized } from './api.js';
import { slugColor, humanizeTtl } from './utils.js';

window.novaApp = function () {
  return {
    token: getToken() || '',
    loginValue: '',
    loginError: '',
    loginBusy: false,
    route: parseRoute(),
    galaxies: [],
    currentGalaxy: null,
    agents: [],
    pendingAgents: [],
    activeAgents: [],
    showCreateGalaxy: false,
    showCreateInvite: false,
    revealedInvite: null,
    approveTarget: null,
    toasts: [],
    sse: null,

    init() {
      onUnauthorized(() => {
        this.token = '';
        location.hash = '';
        this.route = parseRoute();
        this.pushToast('Session ended', 'err');
      });
      window.addEventListener('hashchange', () => {
        this.route = parseRoute();
        this.routeLoad();
      });
      if (this.token) { this.routeLoad(); this.connectSse(); }
    },

    async login() {
      this.loginBusy = true; this.loginError = '';
      try {
        setToken(this.loginValue.trim());
        await api('GET', '/admin/tenants');
        this.token = this.loginValue.trim();
        this.loginValue = '';
        this.routeLoad();
        this.connectSse();
      } catch (e) {
        clearToken();
        this.token = '';
        if (e.name === 'AbortError') this.loginError = 'Admin API unreachable.';
        else if (e.status === 401)   this.loginError = 'Invalid token.';
        else                         this.loginError = e.message || 'Login failed.';
      } finally {
        this.loginBusy = false;
      }
    },

    logout() {
      clearToken();
      this.token = '';
      if (this.sse) { this.sse.close(); this.sse = null; }
      location.hash = '';
      this.route = parseRoute();
    },

    async routeLoad() {
      if (!this.token) return;
      if (this.route.name === 'home')   await this.loadGalaxies();
      if (this.route.name === 'galaxy') await this.loadGalaxy(this.route.slug);
    },

    async loadGalaxies() {
      try { this.galaxies = await api('GET', '/admin/tenants') || []; }
      catch (e) { this.pushToast(e.message || 'Load failed', 'err'); }
    },

    async loadGalaxy(slug) {
      try {
        const all = await api('GET', '/admin/tenants') || [];
        const match = all.find(t => t.slug === slug || t.id === slug);
        if (!match) { this.currentGalaxy = null; return; }
        this.currentGalaxy = match;
        this.agents = await api('GET', `/admin/tenants/${encodeURIComponent(match.id)}/agents`) || [];
        this.pendingAgents = this.agents.filter(a => a.status === 'pending');
        this.activeAgents  = this.agents.filter(a => a.status !== 'pending');
      } catch (e) {
        if (e.status === 404) this.currentGalaxy = null;
        else this.pushToast(e.message || 'Load failed', 'err');
      }
    },

    async createGalaxy(form) {
      const t = await api('POST', '/admin/tenants', form);
      this.showCreateGalaxy = false;
      location.hash = `#/galaxy/${encodeURIComponent(t.slug)}`;
      this.pushToast(`Galaxy "${t.slug}" forged`, 'ok');
    },

    async createInvite(form) {
      const id = this.currentGalaxy.id;
      const res = await api('POST', `/admin/tenants/${encodeURIComponent(id)}/invites`, form);
      this.revealedInvite = res;
      this.showCreateInvite = false;
    },

    dismissReveal() { this.revealedInvite = null; },

    async approve(agentId, form) {
      const id = this.currentGalaxy.id;
      try {
        const res = await api('POST', `/admin/tenants/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/approve`, form);
        this.approveTarget = null;
        this.pushToast(`UCAN issued · ${res.ucan.cid.slice(0, 12)}…`, 'ok');
        await this.loadGalaxy(this.route.slug);
      } catch (e) { this.pushToast(e.message || 'Approval failed', 'err'); }
    },

    async reject(agentId) {
      const id = this.currentGalaxy.id;
      if (!confirm(`Reject ${agentId}? This cannot be undone.`)) return;
      try {
        await api('POST', `/admin/tenants/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}/reject`);
        this.pushToast('Planet rejected', 'ok');
        await this.loadGalaxy(this.route.slug);
      } catch (e) { this.pushToast(e.message || 'Reject failed', 'err'); }
    },

    connectSse() {
      let attempt = 0;
      const open = () => {
        this.sse = new EventSource('/admin/events');
        this.sse.addEventListener('agent', (ev) => this.handleSseAgent(ev));
        this.sse.addEventListener('tenant', () => this.loadGalaxies());
        this.sse.onopen = () => { attempt = 0; };
        this.sse.onerror = () => {
          this.sse && this.sse.close();
          const delay = Math.min(30000, 1000 * Math.pow(2, attempt++));
          setTimeout(open, delay);
        };
      };
      open();
    },

    handleSseAgent(ev) {
      if (!this.currentGalaxy) return;
      try {
        const msg = JSON.parse(ev.data);
        const galaxyId = this.currentGalaxy.id;
        if (msg.tenantId && (msg.tenantId === galaxyId || msg.tenantId === this.currentGalaxy.slug)) {
          this.loadGalaxy(this.route.slug);
        }
      } catch {}
    },

    pushToast(text, kind = 'ok') {
      const id = Math.random().toString(36).slice(2);
      this.toasts.push({ id, text, kind });
      setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 4000);
    },

    planetStyle(slug) {
      const c = slugColor(slug || 'x');
      return `--planet-light:${c.light};--planet-dark:${c.dark};--planet-glow:${c.glow}`;
    },
    humanizeTtl,
  };
};

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const galaxy = h.match(/^\/galaxy\/([^/]+)$/);
  if (galaxy) return { name: 'galaxy', slug: decodeURIComponent(galaxy[1]) };
  return { name: 'home' };
}
