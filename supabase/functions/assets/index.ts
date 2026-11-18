// RackGrid ↔ IT documentation / asset platform bridge — a Supabase Edge Function.
//
// Supported platforms: IT Glue, Hudu, NinjaOne and Snipe-IT. Anything else can be imported
// in the app from a CSV export, without this function.
//
// The browser never sees the platform's API key. This function:
//   1. checks the caller is signed in and a member of the team (using their own token),
//   2. reads that team's platform settings and key from Supabase Vault (service role only),
//   3. makes read-only requests to the platform from a short list of allowed actions,
//   4. returns only the fields RackGrid needs, in one common shape. Passwords and documents are never requested.
//
// Deploy: see SETUP.md → "Connect an IT documentation or asset platform". No other files or packages are needed.

const env = (k: string): string => Deno.env.get(k) ?? "";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function corsHeaders(req: Request): Record<string, string> {
  const allowed = env("RACKGRID_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  return {
    "access-control-allow-origin": !allowed.length ? "*" : allowed.includes(origin) ? origin : allowed[0],
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  };
}
const reply = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "content-type": "application/json" } });

/* ---------- Supabase ---------- */
async function rpc(name: string, args: Record<string, unknown>, headers: Record<string, string>) {
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(args),
  });
  if (r.status === 401) throw new HttpError(401, "Your session has expired. Sign in again.");
  if (!r.ok) throw new HttpError(r.status >= 500 ? 502 : 403, "The team database refused the request.");
  return await r.json();
}
function serviceHeaders(): Record<string, string> {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  const h: Record<string, string> = { apikey: k };
  if (k.startsWith("eyJ")) h.authorization = `Bearer ${k}`; // legacy JWT keys; new sb_secret_ keys go in apikey only
  return h;
}

/* ---------- common shapes ---------- */
type Creds = { provider: string; key: string; clientId: string; region: string; baseUrl: string };
type Config = Record<string, unknown>;
const s = (v: unknown) => (v == null ? "" : String(v));
const stripHtml = (h: unknown) => s(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
const firstIp = (v: unknown): string => {
  const list = Array.isArray(v) ? v.map(s) : s(v).split(/[\s,;]+/);
  return list.find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x) && !x.startsWith("169.254.") && x !== "127.0.0.1") || "";
};
const ID = /^[0-9]{1,15}$/;
function needId(v: unknown, what: string) {
  const t = s(v);
  if (!ID.test(t)) throw new HttpError(400, `Choose ${what} first.`);
  return t;
}
const MAX_PAGES = 10;

const NAMES: Record<string, string> = { itglue: "IT Glue", hudu: "Hudu", ninjaone: "NinjaOne", snipeit: "Snipe-IT" };

// One request to the platform, with friendly errors.
async function call(c: Creds, url: string, init: RequestInit = {}) {
  const name = NAMES[c.provider] || "The platform";
  let r: Response;
  try { r = await fetch(url, { ...init, redirect: "error" }); } catch { throw new HttpError(502, `Couldn't reach ${name}. Check the address and try again in a moment.`); }
  if (r.status === 401 || r.status === 403) throw new HttpError(400, `${name} rejected the API credentials. Ask an owner or administrator to check them under Team & invites.`);
  if (r.status === 429) throw new HttpError(429, `${name}'s rate limit was reached. Wait a few minutes and try again.`);
  if (r.status === 404) throw new HttpError(404, `That item wasn't found in ${name}. It may have been deleted or archived.`);
  if (!r.ok) throw new HttpError(502, `${name} returned an error (${r.status}). Try again later.`);
  let j: any;
  try { j = await r.json(); } catch { throw new HttpError(502, `${name} sent back something that isn't JSON. Check the address under Team & invites.`); }
  if (j && j.status === "error") { // Snipe-IT reports some errors with HTTP 200
    const m = s(typeof j.messages === "string" ? j.messages : JSON.stringify(j.messages));
    if (/unauth|token/i.test(m)) throw new HttpError(400, `${name} rejected the API credentials. Ask an owner or administrator to check them under Team & invites.`);
    if (/not found|does not exist/i.test(m)) throw new HttpError(404, `That item wasn't found in ${name}. It may have been deleted or archived.`);
    throw new HttpError(502, `${name} returned an error: ${m.slice(0, 200)}`);
  }
  return j;
}
const qs = (params: Record<string, string | number>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.set(k, String(v));
  const t = u.toString(); return t ? "?" + t : "";
};

// Self-hosted platforms (Hudu, Snipe-IT) are reached at the address the team saved. Only public https addresses are allowed.
function safeBase(raw: string): string {
  const test = env("RACKGRID_TEST_API_BASE");
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(409, "The platform address saved for this team isn't valid. Fix it under Team & invites."); }
  const h = u.hostname.toLowerCase();
  const privateHost = h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "[::1]" ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^\[(fc|fd|fe80)/.test(h) || h === "metadata.google.internal";
  if (!test && (u.protocol !== "https:" || privateHost || u.username || u.password)) {
    throw new HttpError(409, "The platform address must be a public https:// address. Fix it under Team & invites.");
  }
  return (u.origin + u.pathname).replace(/\/+$/, "");
}
function base(c: Creds): string {
  const test = env("RACKGRID_TEST_API_BASE") || (c.provider === "itglue" ? env("ITGLUE_API_BASE") : "");
  if (test) return test.replace(/\/+$/, "") + (env("RACKGRID_TEST_API_BASE") ? "/" + c.provider : "");
  if (c.provider === "itglue") return ({ us: "https://api.itglue.com", eu: "https://api.eu.itglue.com", au: "https://api.au.itglue.com" } as Record<string, string>)[c.region] || "https://api.itglue.com";
  if (c.provider === "ninjaone") return ({ app: "https://app.ninjarmm.com", us2: "https://us2.ninjarmm.com", eu: "https://eu.ninjarmm.com", ca: "https://ca.ninjarmm.com", oc: "https://oc.ninjarmm.com" } as Record<string, string>)[c.region] || "https://app.ninjarmm.com";
  return safeBase(c.baseUrl);
}

type Provider = {
  test(c: Creds): Promise<{ organizations: number }>;
  organizations(c: Creds): Promise<{ items: unknown[]; truncated: boolean }>;
  configurations(c: Creds, org: string): Promise<{ items: Config[]; truncated: boolean }>;
  configuration(c: Creds, id: string): Promise<Config>;
  locations(c: Creds, org: string): Promise<{ items: unknown[] }>;
};

/* ---------- IT Glue (JSON:API, x-api-key) ---------- */
const A = (o: any) => (o && o.attributes) || {};
const itgH = (c: Creds) => ({ "x-api-key": c.key, accept: "application/vnd.api+json" });
const itgGet = (c: Creds, path: string, p: Record<string, string | number> = {}) => call(c, base(c) + path + qs(p), { headers: itgH(c) });
async function itgPages(c: Creds, path: string, params: Record<string, string | number>, map: (o: any) => any) {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await itgGet(c, path, { ...params, "page[size]": 1000, "page[number]": page });
    for (const o of j.data || []) out.push(map(o));
    const total = Number(j.meta?.["total-pages"] ?? 1);
    if (!j.data?.length || page >= total) return { items: out, truncated: false };
  }
  return { items: out, truncated: true };
}
function itgConfig(o: any): Config {
  const a = A(o);
  return {
    id: s(o.id), name: s(a.name), hostname: s(a.hostname), ip: s(a["primary-ip"]), mac: s(a["mac-address"]),
    serial: s(a["serial-number"]), assetTag: s(a["asset-tag"]), type: s(a["configuration-type-name"]),
    status: s(a["configuration-status-name"]), manufacturer: s(a["manufacturer-name"]), model: s(a["model-name"]),
    os: s(a["operating-system-name"]), location: s(a["location-name"]), locationId: s(a["location-id"]),
    orgId: s(a["organization-id"]), org: s(a["organization-name"]), warranty: s(a["warranty-expires-at"]),
    installed: s(a["installed-at"]), url: s(a["resource-url"]), archived: !!a.archived, notes: stripHtml(a.notes),
  };
}
const itglue: Provider = {
  async test(c) { const j = await itgGet(c, "/organizations", { "page[size]": 1 }); return { organizations: Number(j.meta?.["total-count"] ?? (j.data || []).length) }; },
  organizations: (c) => itgPages(c, "/organizations", { sort: "name" }, (o) => ({ id: s(o.id), name: s(A(o).name) })),
  configurations: (c, org) => itgPages(c, "/configurations", { "filter[organization_id]": org, "filter[archived]": "false", sort: "name" }, itgConfig),
  async configuration(c, id) {
    const j = await itgGet(c, `/configurations/${id}`, { include: "configuration_interfaces" });
    const interfaces = (j.included || []).filter((x: any) => /configuration.interfaces/.test(x.type)).map((o: any) => {
      const a = A(o); return { name: s(a.name), ip: s(a["ip-address"]), mac: s(a["mac-address"]), primary: !!a.primary };
    });
    return { ...itgConfig(j.data), interfaces };
  },
  async locations(c, org) {
    return await itgPages(c, `/organizations/${org}/relationships/locations`, { sort: "name" }, (o) => {
      const a = A(o);
      return { id: s(o.id), name: s(a.name), primary: !!a.primary, address1: s(a["address-1"]), address2: s(a["address-2"]), city: s(a.city), region: s(a["region-name"]), postal: s(a["postal-code"]), country: s(a["country-name"]), phone: s(a.phone) };
    });
  },
};

/* ---------- Hudu (REST, x-api-key, page / page_size) ---------- */
const huH = (c: Creds) => ({ "x-api-key": c.key, accept: "application/json" });
const huGet = (c: Creds, path: string, p: Record<string, string | number> = {}) => call(c, base(c) + "/api/v1" + path + qs(p), { headers: huH(c) });
async function huPages(c: Creds, path: string, prop: string, p: Record<string, string | number>) {
  const out: any[] = [], size = 100;
  for (let page = 1; page <= MAX_PAGES * 10; page++) {
    const j = await huGet(c, path, { ...p, page, page_size: size });
    const list = j[prop] || [];
    out.push(...list);
    if (list.length < size) return { items: out, truncated: false };
    if (out.length >= 10000) break;
  }
  return { items: out, truncated: true };
}
function huField(a: any, re: RegExp): string {
  const f = (a.fields || []).find((x: any) => re.test(s(x.label || x.name)));
  return f ? stripHtml(f.value).slice(0, 300) : "";
}
function huConfig(c: Creds, a: any): Config {
  const url = s(a.url);
  return {
    id: s(a.id), name: s(a.name), type: s(a.asset_type || a.asset_layout_name), status: a.archived ? "Archived" : "",
    manufacturer: s(a.primary_manufacturer) || huField(a, /manufacturer|make|vendor/i), model: s(a.primary_model) || huField(a, /^model/i),
    serial: s(a.primary_serial) || huField(a, /serial/i), ip: firstIp(huField(a, /\bip\b|ip address/i)), mac: huField(a, /\bmac\b/i),
    hostname: huField(a, /host ?name|dns name|fqdn/i), os: huField(a, /operating system|^os$/i), location: huField(a, /location|site|room/i),
    assetTag: huField(a, /asset tag/i), warranty: huField(a, /warranty/i).slice(0, 10), notes: huField(a, /^notes?$/i),
    orgId: s(a.company_id), org: s(a.company_name), url: /^https?:\/\//.test(url) ? url : url ? base(c) + url : "", archived: !!a.archived,
  };
}
const hudu: Provider = {
  async test(c) { const r = await huPages(c, "/companies", "companies", {}); return { organizations: r.items.length }; },
  async organizations(c) {
    const r = await huPages(c, "/companies", "companies", {});
    return { items: r.items.filter((x: any) => !x.archived).map((x: any) => ({ id: s(x.id), name: s(x.name) })).sort((a: any, b: any) => a.name.localeCompare(b.name)), truncated: r.truncated };
  },
  async configurations(c, org) {
    const r = await huPages(c, "/assets", "assets", { company_id: org, archived: "false" });
    return { items: r.items.filter((a: any) => !a.archived).map((a: any) => huConfig(c, a)), truncated: r.truncated };
  },
  async configuration(c, id) {
    const j = await huGet(c, "/assets", { id });
    const a = (j.assets || []).find((x: any) => s(x.id) === id) || j.asset;
    if (!a) throw new HttpError(404, "That item wasn't found in Hudu. It may have been deleted or archived.");
    return huConfig(c, a);
  },
  async locations(c, org) {
    const j = await huGet(c, `/companies/${org}`);
    const x = j.company || j;
    const one = { id: s(x.id || org), name: `${s(x.name) || "Company"} (company address)`, primary: true, address1: s(x.address_line_1), address2: s(x.address_line_2), city: s(x.city), region: s(x.state), postal: s(x.zip), country: s(x.country_name), phone: s(x.phone_number) };
    return { items: one.address1 || one.city ? [one] : [] };
  },
};

/* ---------- Snipe-IT (REST, Bearer token, limit / offset) ---------- */
const snH = (c: Creds) => ({ authorization: `Bearer ${c.key}`, accept: "application/json" });
const snGet = (c: Creds, path: string, p: Record<string, string | number> = {}) => call(c, base(c) + "/api/v1" + path + qs(p), { headers: snH(c) });
async function snPages(c: Creds, path: string, p: Record<string, string | number>) {
  const out: any[] = [], size = 500;
  for (let page = 0; page < 20; page++) {
    const j = await snGet(c, path, { ...p, limit: size, offset: page * size });
    const rows = j.rows || [];
    out.push(...rows);
    if (!rows.length || out.length >= Number(j.total ?? 0)) return { items: out, truncated: false };
  }
  return { items: out, truncated: true };
}
function snCustom(a: any, re: RegExp): string {
  for (const [k, v] of Object.entries(a.custom_fields || {})) if (re.test(k)) return s((v as any)?.value ?? v).slice(0, 300);
  return "";
}
function snConfig(c: Creds, a: any): Config {
  const model = s(a.model?.name) || s(a.model_number);
  return {
    id: s(a.id), name: stripHtml(a.name) || s(a.asset_tag) || model, type: stripHtml(a.category?.name), status: stripHtml(a.status_label?.name),
    manufacturer: stripHtml(a.manufacturer?.name), model: stripHtml(model), serial: stripHtml(a.serial), assetTag: stripHtml(a.asset_tag),
    ip: firstIp(snCustom(a, /\bip\b|ip address/i)), mac: snCustom(a, /\bmac\b/i), hostname: snCustom(a, /host ?name|dns|fqdn/i), os: snCustom(a, /operating system|^os$/i),
    location: stripHtml(a.location?.name || a.rtd_location?.name), warranty: s(a.warranty_expires?.date), installed: s(a.purchase_date?.date),
    orgId: s(a.company?.id), org: stripHtml(a.company?.name), notes: stripHtml(a.notes), url: `${base(c)}/hardware/${s(a.id)}`,
  };
}
const snipeit: Provider = {
  async test(c) {
    const j = await snGet(c, "/hardware", { limit: 1 }); let orgs = 0;
    try { orgs = Number((await snGet(c, "/companies", { limit: 1 })).total ?? 0); } catch (e) { if (e instanceof HttpError && e.status === 400) throw e; }
    return { organizations: orgs, assets: Number(j.total ?? 0) };
  },
  async organizations(c) {
    let items: any[] = [];
    try { items = (await snPages(c, "/companies", { sort: "name", order: "asc" })).items.map((x: any) => ({ id: s(x.id), name: stripHtml(x.name) })); } catch (e) { if (!(e instanceof HttpError) || e.status === 400) throw e; }
    return { items: [{ id: "0", name: "All assets" }, ...items], truncated: false };
  },
  async configurations(c, org) {
    const r = await snPages(c, "/hardware", { sort: "name", order: "asc", ...(org !== "0" ? { company_id: org } : {}) });
    return { items: r.items.map((a: any) => snConfig(c, a)), truncated: r.truncated };
  },
  async configuration(c, id) { return snConfig(c, await snGet(c, `/hardware/${id}`)); },
  async locations(c) {
    const r = await snPages(c, "/locations", { sort: "name", order: "asc" });
    return { items: r.items.map((x: any) => ({ id: s(x.id), name: stripHtml(x.name), address1: stripHtml(x.address), address2: stripHtml(x.address2), city: stripHtml(x.city), region: stripHtml(x.state), postal: stripHtml(x.zip), country: stripHtml(x.country), phone: stripHtml(x.phone) })) };
  },
};

/* ---------- NinjaOne (OAuth client credentials, read-only "monitoring" scope) ---------- */
async function ninjaToken(c: Creds): Promise<string> {
  if (!c.clientId) throw new HttpError(409, "The NinjaOne client ID is missing. Add it under Team & invites.");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.key, scope: "monitoring" });
  let r: Response;
  try { r = await fetch(base(c) + "/ws/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, redirect: "error" }); }
  catch { throw new HttpError(502, "Couldn't reach NinjaOne. Check the region and try again in a moment."); }
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new HttpError(400, "NinjaOne rejected the client ID or secret, or the region is wrong. Ask an owner or administrator to check them under Team & invites.");
  if (!r.ok) throw new HttpError(502, `NinjaOne returned an error (${r.status}). Try again later.`);
  const j = await r.json();
  if (!j.access_token) throw new HttpError(400, "NinjaOne didn't return an access token. Check the API client's grant type is Client Credentials with the Monitoring scope.");
  return j.access_token;
}
const NODE: Record<string, string> = {
  WINDOWS_SERVER: "Windows server", WINDOWS_WORKSTATION: "Windows workstation", MAC: "Mac workstation", MAC_SERVER: "Mac server",
  LINUX_SERVER: "Linux server", LINUX_WORKSTATION: "Linux workstation", VMWARE_VM_HOST: "VMware host", VMWARE_VM_GUEST: "Virtual machine",
  HYPERV_VMM_HOST: "Hyper-V host", HYPERV_VMM_GUEST: "Virtual machine", CLOUD_MONITOR_TARGET: "Cloud monitor", NMS_SWITCH: "Switch",
  NMS_ROUTER: "Router", NMS_FIREWALL: "Firewall", NMS_PRINTER: "Printer", NMS_WAP: "Access point", NMS_SERVER: "Server", NMS_PHONE: "Phone",
  NMS_VM_HOST: "VM host", NMS_APPLIANCE: "Appliance", NMS_NAS: "Storage", NMS_OTHER: "Network device", NMS_DIAL_MANAGER: "Network device",
  NMS_NETWORK_MANAGEMENT_AGENT: "Network management agent", NMS_COMPUTER: "Computer", NMS_IPSLA: "Network monitor", NMS_VIRTUAL_MACHINE: "Virtual machine",
};
const nodeType = (n: string) => NODE[n] || n.replace(/^NMS_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase());
function ninjaConfig(c: Creds, d: any, locs: Record<string, string> = {}, orgName = ""): Config {
  const sys = d.system || {};
  return {
    id: s(d.id), name: s(d.displayName || d.systemName || d.dnsName), hostname: s(d.dnsName || d.systemName), type: nodeType(s(d.nodeClass)),
    status: d.offline ? "Offline" : "Online", manufacturer: s(sys.manufacturer), model: s(sys.model), serial: s(sys.serialNumber || sys.biosSerialNumber),
    ip: firstIp(d.ipAddresses), mac: s((d.macAddresses || [])[0]), os: s(d.os?.name), orgId: s(d.organizationId), org: orgName,
    location: locs[s(d.locationId)] || "", locationId: s(d.locationId), url: `${base(c)}/#/deviceDashboard/${s(d.id)}/overview`,
  };
}
async function ninjaGet(c: Creds, tok: string, path: string, p: Record<string, string | number> = {}) {
  return call(c, base(c) + "/v2" + path + qs(p), { headers: { authorization: `Bearer ${tok}`, accept: "application/json" } });
}
async function ninjaPages(c: Creds, tok: string, path: string, p: Record<string, string | number>) {
  const out: any[] = [], size = 1000; let after = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const list = await ninjaGet(c, tok, path, { ...p, pageSize: size, ...(after ? { after } : {}) });
    const arr = Array.isArray(list) ? list : [];
    out.push(...arr);
    if (arr.length < size) return { items: out, truncated: false };
    after = s(arr[arr.length - 1].id);
  }
  return { items: out, truncated: true };
}
const ninjaone: Provider = {
  async test(c) { const t = await ninjaToken(c); return { organizations: (await ninjaPages(c, t, "/organizations", {})).items.length }; },
  async organizations(c) {
    const t = await ninjaToken(c); const r = await ninjaPages(c, t, "/organizations", {});
    return { items: r.items.map((o: any) => ({ id: s(o.id), name: s(o.name) })).sort((a: any, b: any) => a.name.localeCompare(b.name)), truncated: r.truncated };
  },
  async configurations(c, org) {
    const t = await ninjaToken(c);
    const [o, locs] = await Promise.all([ninjaGet(c, t, `/organization/${org}`).catch(() => ({})), ninjaGet(c, t, `/organization/${org}/locations`).catch(() => [])]);
    const lm: Record<string, string> = {}; for (const l of (Array.isArray(locs) ? locs : [])) lm[s(l.id)] = s(l.name);
    const r = await ninjaPages(c, t, "/devices-detailed", { df: `org=${org}` });
    return { items: r.items.map((d: any) => ninjaConfig(c, d, lm, s((o as any).name))), truncated: r.truncated };
  },
  async configuration(c, id) { const t = await ninjaToken(c); return ninjaConfig(c, await ninjaGet(c, t, `/device/${id}`)); },
  async locations(c, org) {
    const t = await ninjaToken(c); const l = await ninjaGet(c, t, `/organization/${org}/locations`);
    return { items: (Array.isArray(l) ? l : []).map((x: any) => ({ id: s(x.id), name: s(x.name), address1: s(x.address).replace(/\s*\n\s*/g, ", "), address2: "", city: "", region: "", postal: "", country: "", phone: "" })) };
  },
};

const PROVIDERS: Record<string, Provider> = { itglue, hudu, snipeit, ninjaone };

/* ---------- allowed actions (all read-only) ---------- */
const ACTIONS: Record<string, (p: Provider, c: Creds, b: any) => Promise<unknown>> = {
  test: async (p, c) => ({ ok: true, provider: c.provider, ...(await p.test(c)) }),
  organizations: (p, c) => p.organizations(c),
  configurations: (p, c, b) => p.configurations(c, needId(b.org, "an organization")),
  configuration: (p, c, b) => p.configuration(c, needId(b.id, "a device")),
  locations: (p, c, b) => p.locations(c, needId(b.org, "an organization")),
};

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "Use POST." });
  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!/^Bearer\s+\S+/.test(auth)) throw new HttpError(401, "Sign in first.");
    let body: any;
    try { body = await req.json(); } catch { throw new HttpError(400, "Invalid request."); }
    const team = s(body?.team);
    if (!/^[0-9a-f-]{36}$/i.test(team)) throw new HttpError(400, "Open a team workspace first.");
    const run = ACTIONS[s(body?.action)];
    if (!run) throw new HttpError(400, "Unknown action.");

    // 1. Is the caller a member of this team? Checked with their own token, so RLS rules apply.
    const role = await rpc("team_role", { t: team }, { apikey: env("SUPABASE_ANON_KEY"), authorization: auth });
    if (!role) throw new HttpError(403, "You're not a member of this team.");

    // 2. The team's platform settings and key, decrypted from Vault with the service role.
    const r = await rpc("integration_credentials", { p_team: team }, serviceHeaders());
    if (!r?.key) throw new HttpError(409, "No IT documentation or asset platform is connected for this team yet. An owner or administrator can connect one under Team & invites.");
    const c: Creds = { provider: s(r.provider) || "itglue", key: s(r.key), clientId: s(r.client_id), region: s(r.region), baseUrl: s(r.base_url) };
    const p = PROVIDERS[c.provider];
    if (!p) throw new HttpError(409, "This team's platform isn't supported by this version of the bridge. Deploy the latest supabase/functions/assets.");

    // 3. Read-only calls to the platform.
    return reply(req, 200, await run(p, c, body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : "Something went wrong talking to the platform.";
    if (!(e instanceof HttpError)) console.error(e);
    return reply(req, status, { error: message });
  }
}

Deno.serve(handler);
