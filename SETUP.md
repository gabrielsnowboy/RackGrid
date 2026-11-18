# Setting up Team Workspaces

Personal Workspace works with no setup. Team Workspaces sync through a Supabase project that you own. The free tier is enough for most IT teams. Setup takes about 10 minutes and is done once, by one person.

## 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
2. Pick a name (e.g. `rackgrid`), a database password, and the region closest to you. Wait until the project is ready.

## 2. Create the RackGrid tables

1. In your project, open **SQL Editor** → **New query**.
2. Open [`supabase/schema.sql`](supabase/schema.sql) from this repository, copy all of it, paste it in, and click **Run**.

This creates teams, members, invitations, racks and sites, the activity history, and a private `floorplans` storage bucket. It also turns on live updates. Row Level Security makes sure people only ever see teams they belong to. You can run the file again later; it won't delete anything.

## 3. Set up sign-in

1. Go to **Authentication** → **URL Configuration**.
2. Set **Site URL** to where RackGrid is hosted, e.g. `https://<your-username>.github.io/rackgrid/`.
3. Add the same address under **Redirect URLs**.

Email sign-in is on by default. By default Supabase asks new users to confirm their email. Keep that on for real use. Supabase's built-in email sender is rate-limited, so for a larger team add your own SMTP server under **Authentication → Emails → SMTP Settings**.

## 4. Connect RackGrid to the project

1. Go to **Project Settings** → **API** (or **Data API**) and copy the **Project URL** and the **anon public** key.
2. Edit `config.js` in this repository:

```js
window.RACKGRID_CONFIG = {
  supabaseUrl: "https://abcdefgh.supabase.co",
  supabaseAnonKey: "eyJhbGciOi..."
};
```

3. Commit the change. GitHub Pages updates within a minute.

The anon key is designed to be public. What protects your data is Row Level Security in `schema.sql`. **Never** put the `service_role` key in RackGrid.

If you'd rather not commit the keys, leave `config.js` empty. Each person can paste the URL and key on the Team Workspace screen, and it's saved in their browser.

**Before inviting anyone, read [Security in the README](README.md#security).** If your repository is public, at least turn off open sign-ups in Supabase so strangers can't create accounts in your project.

## 5. Create your team

1. Open RackGrid → **Open Team Workspace** → **Create an account**.
2. Under **Create a team**, enter your organization's name. Tick **Copy my Personal Workspace into this team** to bring over the racks, sites and floor plans you already have.
3. Open **Team & invites** in the sidebar → **Create invitation** and send the link or code to your colleagues.

## Roles

| | Owner | Administrator | Member |
|---|:-:|:-:|:-:|
| View and edit racks, sites, floor plans, wall ports, access points and floor plan devices | ✓ | ✓ | ✓ |
| See activity history | ✓ | ✓ | ✓ |
| Invite people (as member or administrator) | ✓ | ✓ | |
| Remove members | ✓ | ✓ (members only) | |
| Rename the team | ✓ | ✓ | |
| Import, link and refresh devices from the team's platform (IT Glue, Hudu, NinjaOne, Snipe-IT) | ✓ | ✓ | ✓ |
| Connect, switch or disconnect the platform, choose the default organization | ✓ | ✓ | |
| Change roles, transfer ownership | ✓ | | |
| Delete the team | ✓ | | |

Each team has one owner. To hand a team over, the owner picks **Make owner…** next to a member and becomes an administrator.

## Connect an IT documentation or asset platform (optional)

RackGrid can read devices and site addresses from the platform your MSP or IT team already uses. It only reads; it never changes anything there.

| Platform | Live connection | What you need |
|---|:-:|---|
| [IT Glue](https://www.itglue.com/) | ✓ | An API key and your data center (US, EU or Australia) |
| [Hudu](https://www.hudu.com/) | ✓ | An API key and your Hudu address, e.g. `https://yourcompany.huducloud.com` |
| [NinjaOne](https://www.ninjaone.com/) | ✓ | An API client ID and secret, and your region |
| [Snipe-IT](https://snipeitapp.com/) | ✓ | An API key and your Snipe-IT address |
| N-able, Lansweeper, Freshservice, ConnectWise, Datto RMM and any other platform or spreadsheet | CSV import | A CSV export of your devices or assets |

A team connects one platform at a time. CSV import works in every workspace, with or without a connection.

**What RackGrid reads:**
- **Organizations or companies:** names.
- **Devices / configurations / assets:** name, type or category, status, manufacturer, model, serial number, IP, hostname, MAC address, asset tag, operating system, location, warranty expiry, notes and a link back to the platform. For IT Glue, also network interfaces.
- **Locations:** addresses. (Hudu: the company's address. NinjaOne: the location's address text.)

It never requests passwords, documents, contacts or other records.

**How the key is protected:** the API key (or NinjaOne client secret) never reaches anyone's browser. It's stored encrypted in Supabase Vault in your project. Only a small bridge function (`supabase/functions/assets`) can use it, and only on behalf of a signed-in team member. Nobody can read it back, not even the team owner: they can only replace or delete it. For Hudu and Snipe-IT the bridge only connects to public `https://` addresses.

### 1. Update the database

Run `supabase/schema.sql` again in **SQL Editor** (the same way as step 2 above). It adds the platform settings and keeps all existing data, including an IT Glue connection you made with an earlier version.

### 2. Deploy the bridge function

**From the Supabase dashboard:**
1. Go to **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `assets`.
3. Replace the sample code with everything in `supabase/functions/assets/index.ts`, then click **Deploy**.

**Or with the Supabase CLI**, from this repository's folder: `supabase functions deploy assets --project-ref <your-project-ref>`

**Recommended:** under **Edge Functions → Secrets**, add `RACKGRID_ALLOWED_ORIGINS` with your RackGrid address, e.g. `https://<your-username>.github.io`. The function then only answers requests from your copy of RackGrid.

**Upgrading from the IT Glue-only version?** Deploy `assets` as above, then delete the old `itglue` function. Until `assets` is deployed, RackGrid falls back to `itglue` for IT Glue; Hudu, NinjaOne and Snipe-IT need `assets`.

### 3. Create read-only credentials

Use a dedicated key just for RackGrid, with the least access the platform allows.

- **IT Glue:** **Account → Settings → API Keys** → generate a new custom key named `RackGrid`. Leave password access turned off. You need to be an IT Glue administrator, and API access depends on your subscription.
- **Hudu:** **Admin → API Keys** → create a key named `RackGrid`. Leave password access off.
- **NinjaOne:** **Administration → Apps → API → Client app IDs** → **Add**. Choose **API Services (machine-to-machine)**, give it only the **Monitoring** scope and the **Client Credentials** grant type, then save and copy the client ID and secret.
- **Snipe-IT:** create a user who can only view assets, sign in as that user, then open the profile menu → **Manage API Keys** → **Create New Token**.

Each platform shows the secret only once, so copy it straight away.

### 4. Connect it in RackGrid

1. Open your team → **Team & invites** → **IT documentation & asset platform**.
2. Choose the **Platform**, then fill in what it asks for: the data center or region (IT Glue, NinjaOne), the address (Hudu, Snipe-IT), and the client ID (NinjaOne).
3. Paste the key or secret and click **Connect**. RackGrid tests the connection straight away.
4. Pick a **Default organization** (or company), usually the client whose server room this team documents.

To move to another platform later, choose it in the same place and click **Switch to…**. Devices already linked to the old platform keep their details.

### Using it in RackGrid

- **Import devices:** select a rack → **Import from IT Glue / Hudu / NinjaOne / Snipe-IT…**. Pick the organization or company, search or filter by type, tick devices and click **Add**.
  - Switches, firewalls, servers and other rack equipment go into the first free units. Drag them into place afterwards.
  - Access points go on the current floor plan.
  - **Network and rack equipment only** hides workstations, printers, phones and virtual machines. Untick it to import PCs, printers, phones, cameras and displays too: they're placed on the current floor plan as devices, ready to drag into position. Virtual machines and software are never placed.
- **Link an existing device:** select it → **Link to …** → **Link**. RackGrid copies the model, serial number and management IP, and keeps the device's name and position.
- **Refresh:** **Refresh from …** on a device, or **Refresh N linked devices** on the rack. Each device panel shows the platform's details (hostname, MAC, OS, location, warranty with an expiry warning, and more) plus an **Open in …** link.
- **Site address:** on the Site tab, **Fill address from …** copies the address of a location.
- **CSV import (any platform, any workspace):** click **Import devices…** in the sidebar and choose **From a CSV export**. Pick where the file came from, then choose the file. RackGrid matches the columns from IT Glue, Hudu, NinjaOne, N-able, Snipe-IT, Lansweeper, Freshservice, ConnectWise and Datto exports automatically, and you can correct the matching. Only a name column is required. Devices imported from CSV can't be refreshed; import a newer export instead.

API limits: IT Glue allows 3,000 requests every 5 minutes. Hudu, NinjaOne and Snipe-IT have their own limits. Importing an organization uses one request per page of devices (100 to 1,000 devices per page, depending on the platform); refreshing uses one or two requests per device.

## How syncing works

- Each rack and each site is saved as one versioned record. When two people change the same rack at the same time, RackGrid merges both sets of changes. One person moving a switch while another renames a patch panel keeps both edits. If two people change the very same field, the last save wins.
- Changes from others appear live, usually within a second.
- **Offline:** the team's racks and sites are kept in your browser. If the connection drops you can keep working. Changes are queued on your device and sent when you reconnect. The sidebar shows "Offline · N changes waiting" until they're sent. Floor plans added while offline upload when you're back online.
- The app itself is cached too, so it opens without a connection once you've loaded it before.
- **Activity history** records who changed what (moved, added, removed, connected, patched, renamed…) and when. Changes made offline are recorded when they sync, with the time they were made.

## Troubleshooting

- **"Sync paused"** in the sidebar shows the server's reason, e.g. your account was removed from the team. Click **Retry** after fixing it.
- **Invitation link opens the wrong page:** check that the Site URL and Redirect URLs in step 3 match the address you use.
- **"Couldn't reach the RackGrid bridge function":** check that the function is deployed and named exactly `assets`, and that `RACKGRID_ALLOWED_ORIGINS` (if set) matches the address in your browser's address bar.
- **"… rejected the API credentials":** the key or secret was revoked or mistyped, or the data center, region or address is wrong. Paste new credentials under **Team & invites**. For NinjaOne, also check the API client uses the Client Credentials grant type with the Monitoring scope.
- **"The platform address must be a public https:// address":** Hudu and Snipe-IT must be reachable from the internet over https for the bridge to read them. If your Snipe-IT is only on your internal network, use CSV import instead.
- **"Run the updated supabase/schema.sql":** your database is from an earlier version. Run `schema.sql` again in the SQL Editor.
- **The function answers "Invalid JWT":** some newer Supabase projects need **Verify JWT** turned off for the function (Edge Functions → assets → Details). This is safe: the function checks each person's sign-in and team membership itself.
- **Live updates don't appear:** in Supabase, open **Database → Publications → supabase_realtime** and check that `docs`, `activity`, `team_members` and `teams` are enabled. Re-running `schema.sql` turns them on.
