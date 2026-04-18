import { api, setToken, clearToken, getToken, onUnauthorized } from './api.js';
import { slugColor, humanizeTtl } from './utils.js';

function readSidebarState() {
  try { return localStorage.getItem('nova-admin-sidebar-collapsed') === '1'; }
  catch { return false; }
}
function writeSidebarState(collapsed) {
  try { localStorage.setItem('nova-admin-sidebar-collapsed', collapsed ? '1' : '0'); }
  catch {}
}

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
    allAgents: [],
    allAgentsLoading: false,
    allAgentsError: null,
    rotationDeg: 0,
    demoLineActive: false,
    demoLinePath: '',
    hoverGalaxy: null,
    sidebarCollapsed: readSidebarState(),

    get activeTab() {
      switch (this.route.name) {
        case 'home':
        case 'galaxy':  return 'galaxies';
        case 'agents':  return 'agents';
        case 'live':    return 'live';
        case 'audit':   return 'audit';
        default:        return 'galaxies';
      }
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      writeSidebarState(this.sidebarCollapsed);
    },

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
        if (this.route.name === 'live') this.startLiveTicker();
        else this.stopLiveTicker();
      });
      if (this.token) {
        this.routeLoad();
        this.connectSse();
        if (this.route.name === 'live') this.startLiveTicker();
      }
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
      if (this.route.name === 'agents') await this.loadAllAgents();
      if (this.route.name === 'live')   await this.loadAllAgents();
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

    async loadAllAgents() {
      this.allAgentsLoading = true;
      this.allAgentsError = null;
      try {
        const galaxiesPromise = this.galaxies.length === 0
          ? this.loadGalaxies()
          : Promise.resolve();
        const [res] = await Promise.all([api('GET', '/admin/agents'), galaxiesPromise]);
        this.allAgents = res?.agents || [];
      } catch (e) {
        this.allAgentsError = e.message || 'Load failed';
        this.pushToast(this.allAgentsError, 'err');
      } finally {
        this.allAgentsLoading = false;
      }
    },

    galaxySlug(tenantId) {
      const match = this.galaxies.find(g => g.id === tenantId || g.slug === tenantId);
      return match?.slug || tenantId;
    },

    get livePlanets() {
      const agents = this.allAgents;
      if (!agents || agents.length === 0) return [];
      const cx = 400, cy = 300, ringR = 220, labelOffset = 10 + 14;
      const byGalaxy = new Map();
      for (const a of agents) {
        const slug = this.galaxySlug(a.tenantId);
        if (!byGalaxy.has(slug)) byGalaxy.set(slug, []);
        byGalaxy.get(slug).push(a);
      }
      const galaxyKeys = [...byGalaxy.keys()].sort();
      const G = galaxyKeys.length;
      const gap = 10;
      const usable = 360 - G * gap;
      const arcWidth = usable / G;
      const result = [];
      for (let i = 0; i < G; i++) {
        const slug = galaxyKeys[i];
        const arr = byGalaxy.get(slug);
        const startAngle = i * (arcWidth + gap);
        for (let j = 0; j < arr.length; j++) {
          const a = arr[j];
          const baseAngle = startAngle + arcWidth * (j + 0.5) / arr.length;
          const theta = (baseAngle + this.rotationDeg) * Math.PI / 180;
          const colors = slugColor(slug);
          result.push({
            agentId: a.agentId,
            name: a.name,
            galaxySlug: slug,
            x: cx + ringR * Math.cos(theta),
            y: cy + ringR * Math.sin(theta),
            labelX: cx + (ringR + labelOffset) * Math.cos(theta),
            labelY: cy + (ringR + labelOffset) * Math.sin(theta) + 4,
            colorLight: colors.light,
            colorDark: colors.dark,
          });
        }
      }
      return result;
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
      try {
        const msg = JSON.parse(ev.data);
        if (this.activeTab === 'agents' || this.activeTab === 'live') {
          this.loadAllAgents();
          return;
        }
        if (!this.currentGalaxy) return;
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

    startLiveTicker() {
      if (this._liveRaf) return;
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReduced) return;
      let lastTime = performance.now();
      const degPerSec = 360 / 90;
      const tick = (now) => {
        if (this.activeTab !== 'live') {
          this._liveRaf = null;
          return;
        }
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        this.rotationDeg = (this.rotationDeg + degPerSec * dt) % 360;
        this._liveRaf = requestAnimationFrame(tick);
      };
      this._liveRaf = requestAnimationFrame(tick);
    },

    stopLiveTicker() {
      if (this._liveRaf) {
        cancelAnimationFrame(this._liveRaf);
        this._liveRaf = null;
      }
    },

    triggerDemoLine() {
      const planets = this.livePlanets;
      if (planets.length < 2) return;
      if (this._demoTimeout) clearTimeout(this._demoTimeout);
      const a = planets[Math.floor(Math.random() * planets.length)];
      let b;
      do { b = planets[Math.floor(Math.random() * planets.length)]; } while (b.agentId === a.agentId);
      this.demoLinePath = `M ${a.x} ${a.y} Q 400 300 ${b.x} ${b.y}`;
      this.demoLineActive = false;
      requestAnimationFrame(() => { this.demoLineActive = true; });
      this._demoTimeout = setTimeout(() => {
        this.demoLineActive = false;
        this.demoLinePath = '';
        this._demoTimeout = null;
      }, 1600);
    },

    humanizeTtl,
  };
};

function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const galaxy = h.match(/^\/galaxy\/([^/]+)$/);
  if (galaxy) return { name: 'galaxy', slug: decodeURIComponent(galaxy[1]) };
  if (h === '/agents') return { name: 'agents' };
  if (h === '/live')   return { name: 'live' };
  if (h === '/audit')  return { name: 'audit' };
  return { name: 'home' };
}
