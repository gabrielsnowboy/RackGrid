// RackGrid ↔ IT Glue bridge — a Supabase Edge Function.
//
// The browser never sees the IT Glue API key. This function:
//   1. checks the caller is signed in and a member of the team (using their own token),
//   2. reads that team's key from Supabase Vault (service role only),
//   3. makes a read-only request to IT Glue from a short list of allowed actions,
//   4. returns only the fields RackGrid needs. Passwords and documents are never requested.
//
// Deploy: see SETUP.md → "Connect IT Glue". No other files or packages are needed.

const REGIONS: Record<string, string> = {
  us: "https://api.itglue.com",
  eu: "https://api.eu.itglue.com",
  au: "https://api.au.itglue.com",
};
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

/* ---------- IT Glue ---------- */
type Creds = { key: string; region: string };
async function itg(c: Creds, path: string, params: Record<string, string | number> = {}) {
  const base = env("ITGLUE_API_BASE") || REGIONS[c.region] || REGIONS.us;
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, String(v));
  let r: Response;
  try {
    r = await fetch(u, { headers: { "x-api-key": c.key, accept: "application/vnd.api+json" } });
  } catch {
    throw new HttpError(502, "Couldn't reach IT Glue. Try again in a moment.");
  }
  if (r.status === 401 || r.status === 403) throw new HttpError(400, "IT Glue rejected the API key. Ask an owner or administrator to check it under Team & invites → IT Glue, and that it's for the right data center.");
  if (r.status === 429) throw new HttpError(429, "IT Glue's rate limit was reached. Wait a few minutes and try again.");
  if (r.status === 404) throw new HttpError(404, "That item wasn't found in IT Glue. It may have been deleted or archived.");
  if (!r.ok) throw new HttpError(502, `IT Glue returned an error (${r.status}). Try again later.`);
  return await r.json();
}

const A = (o: any) => (o && o.attributes) || {};
const s = (v: unknown) => (v == null ? "" : String(v));
const stripHtml = (h: unknown) => s(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);

function mapConfig(o: any) {
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
const mapInterface = (o: any) => {
  const a = A(o);
  return { name: s(a.name), ip: s(a["ip-address"]), mac: s(a["mac-address"]), primary: !!a.primary, notes: stripHtml(a.notes).slice(0, 300) };
};
function mapLocation(o: any) {
  const a = A(o);
  return {
    id: s(o.id), name: s(a.name), primary: !!a.primary, address1: s(a["address-1"]), address2: s(a["address-2"]),
    city: s(a.city), region: s(a["region-name"]), postal: s(a["postal-code"]), country: s(a["country-name"]), phone: s(a.phone),
  };
}

const ID = /^[0-9]{1,15}$/;
function needId(v: unknown, what: string) {
  const t = s(v);
  if (!ID.test(t)) throw new HttpError(400, `Choose ${what} first.`);
  return t;
}
const MAX_PAGES = 10; // 10 × 1000 records

async function allPages(c: Creds, path: string, params: Record<string, string | number>, map: (o: any) => any) {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await itg(c, path, { ...params, "page[size]": 1000, "page[number]": page });
    for (const o of j.data || []) out.push(map(o));
    const total = Number(j.meta?.["total-pages"] ?? 1);
    if (!j.data?.length || page >= total) return { items: out, truncated: false };
  }
  return { items: out, truncated: true };
}

/* ---------- allowed actions (all read-only) ---------- */
const ACTIONS: Record<string, (c: Creds, b: any) => Promise<unknown>> = {
  async test(c) {
    const j = await itg(c, "/organizations", { "page[size]": 1 });
    return { ok: true, organizations: Number(j.meta?.["total-count"] ?? (j.data || []).length) };
  },
  async organizations(c) {
    return await allPages(c, "/organizations", { sort: "name" }, (o) => ({
      id: s(o.id), name: s(A(o).name), type: s(A(o)["organization-type-name"]), status: s(A(o)["organization-status-name"]),
    }));
  },
  async configurations(c, b) {
    const org = needId(b.org, "an organization");
    return await allPages(c, "/configurations", { "filter[organization_id]": org, "filter[archived]": "false", sort: "name" }, mapConfig);
  },
  async configuration(c, b) {
    const id = needId(b.id, "a configuration");
    const j = await itg(c, `/configurations/${id}`, { include: "configuration_interfaces" });
    const cfg = mapConfig(j.data);
    const interfaces = (j.included || []).filter((x: any) => x.type === "configuration-interfaces" || x.type === "configuration_interfaces").map(mapInterface);
    return { ...cfg, interfaces };
  },
  async locations(c, b) {
    const org = needId(b.org, "an organization");
    return await allPages(c, `/organizations/${org}/relationships/locations`, { sort: "name" }, mapLocation);
  },
};

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "Use POST." });
  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!/^Bearer\s+\S+/.test(auth)) throw new HttpError(401, "Sign in to use IT Glue.");
    let body: any;
    try { body = await req.json(); } catch { throw new HttpError(400, "Invalid request."); }
    const team = s(body?.team);
    if (!/^[0-9a-f-]{36}$/i.test(team)) throw new HttpError(400, "Open a team workspace first.");
    const action = s(body?.action);
    const run = ACTIONS[action];
    if (!run) throw new HttpError(400, "Unknown action.");

    // 1. Is the caller a member of this team? Checked with their own token, so RLS rules apply.
    const role = await rpc("team_role", { t: team }, { apikey: env("SUPABASE_ANON_KEY"), authorization: auth });
    if (!role) throw new HttpError(403, "You're not a member of this team.");

    // 2. The team's IT Glue key, decrypted from Vault with the service role.
    const creds = await rpc("itglue_credentials", { p_team: team }, serviceHeaders());
    if (!creds?.key) throw new HttpError(409, "IT Glue isn't connected for this team yet. An owner or administrator can connect it under Team & invites → IT Glue.");

    // 3. Read-only call to IT Glue.
    return reply(req, 200, await run(creds, body));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : "Something went wrong talking to IT Glue.";
    if (!(e instanceof HttpError)) console.error(e);
    return reply(req, status, { error: message });
  }
}

Deno.serve(handler);
