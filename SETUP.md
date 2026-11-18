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
| Import, link and refresh devices from IT Glue | ✓ | ✓ | ✓ |
| Connect or disconnect IT Glue, choose the default organization | ✓ | ✓ | |
| Change roles, transfer ownership | ✓ | | |
| Delete the team | ✓ | | |

Each team has one owner. To hand a team over, the owner picks **Make owner…** next to a member and becomes an administrator.

## Connect IT Glue (optional)

RackGrid can read devices and site addresses from [IT Glue](https://www.itglue.com/). It only reads; it never changes anything in IT Glue.

**What RackGrid reads:**
- **Organizations:** names.
- **Configurations:** name, type, status, manufacturer, model, serial number, primary IP, hostname, MAC address, asset tag, operating system, location, warranty expiry, notes and the IT Glue link, plus their network interfaces.
- **Locations:** addresses.

It never requests passwords, documents, contacts or flexible assets.

**How the key is protected:** the IT Glue API key never reaches anyone's browser. It's stored encrypted in Supabase Vault in your project. Only a small bridge function (`supabase/functions/itglue`) can use it, and only on behalf of a signed-in team member. Nobody can read the key back, not even the team owner: they can only replace or delete it.

### 1. Update the database

Run `supabase/schema.sql` again in **SQL Editor** (the same way as step 2 above). It adds the IT Glue settings and keeps all existing data.

### 2. Deploy the bridge function

**From the Supabase dashboard:**
1. Go to **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `itglue`.
3. Replace the sample code with everything in `supabase/functions/itglue/index.ts`, then click **Deploy**.

**Or with the Supabase CLI**, from this repository's folder: `supabase functions deploy itglue --project-ref <your-project-ref>`

**Recommended:** under **Edge Functions → Secrets**, add `RACKGRID_ALLOWED_ORIGINS` with your RackGrid address, e.g. `https://<your-username>.github.io`. The function then only answers requests from your copy of RackGrid.

### 3. Create an IT Glue API key

1. In IT Glue, go to **Account → Settings → API Keys** and generate a new custom key. Name it `RackGrid`.
2. **Leave password access turned off.** RackGrid doesn't need it.
3. Copy the key. IT Glue shows it only once.

You need to be an IT Glue administrator to create API keys. API access depends on your IT Glue subscription; if you don't see **API Keys**, ask your IT Glue account manager.

### 4. Connect it in RackGrid

1. Open your team → **Team & invites** → **IT Glue**.
2. Choose your IT Glue data center:
   - United States: your IT Glue address ends in `itglue.com`
   - Europe: `eu.itglue.com`
   - Australia: `au.itglue.com`
3. Paste the key and click **Connect**. RackGrid tests the connection straight away.
4. Pick a **Default organization**, usually the client whose server room this team documents.

### Using IT Glue in RackGrid

- **Import devices:** select a rack → **Import from IT Glue…**. Pick the organization, search or filter by type, tick devices and click **Add**.
  - Switches, firewalls, servers and other rack equipment go into the first free units. Drag them into place afterwards.
  - Access points go on the current floor plan.
  - **Network and rack equipment only** hides workstations, printers, phones and virtual machines. Untick it to import PCs, printers, phones, cameras and displays too: they're placed on the current floor plan as devices, ready to drag into position. Virtual machines and software are never placed.
- **Link an existing device:** select it → **Link to IT Glue…** → **Link**. RackGrid copies the model, serial number and management IP, and keeps the device's name and position.
- **Refresh:** **Refresh from IT Glue** on a device, or **Refresh N linked devices** on the rack. Each device panel shows the IT Glue details: hostname, MAC, OS, location, warranty with an expiry warning, and interfaces, plus an **Open in IT Glue** link.
- **Site address:** on the Site tab, **Fill address from IT Glue…** copies the address of an IT Glue location.
- **Personal Workspace, or without the bridge:** click **IT Glue…** in the sidebar and choose **From a CSV export**. Export the organization's configurations from IT Glue as CSV and choose the file. RackGrid matches the columns, and you can correct the matching if needed. Devices imported this way can't be refreshed.

IT Glue allows 3,000 API requests every 5 minutes per account. Importing one organization uses about one request per 1,000 devices; refreshing uses one request per device.

## How syncing works

- Each rack and each site is saved as one versioned record. When two people change the same rack at the same time, RackGrid merges both sets of changes. One person moving a switch while another renames a patch panel keeps both edits. If two people change the very same field, the last save wins.
- Changes from others appear live, usually within a second.
- **Offline:** the team's racks and sites are kept in your browser. If the connection drops you can keep working. Changes are queued on your device and sent when you reconnect. The sidebar shows "Offline · N changes waiting" until they're sent. Floor plans added while offline upload when you're back online.
- The app itself is cached too, so it opens without a connection once you've loaded it before.
- **Activity history** records who changed what (moved, added, removed, connected, patched, renamed…) and when. Changes made offline are recorded when they sync, with the time they were made.

## Troubleshooting

- **"Sync paused"** in the sidebar shows the server's reason, e.g. your account was removed from the team. Click **Retry** after fixing it.
- **Invitation link opens the wrong page:** check that the Site URL and Redirect URLs in step 3 match the address you use.
- **"Couldn't reach the IT Glue bridge":** check that the function is deployed and named exactly `itglue`, and that `RACKGRID_ALLOWED_ORIGINS` (if set) matches the address in your browser's address bar.
- **"IT Glue rejected the API key":** the key was revoked or mistyped, or the data center is wrong. Paste a new key under **Team & invites → IT Glue**.
- **The function answers "Invalid JWT":** some newer Supabase projects need **Verify JWT** turned off for the function (Edge Functions → itglue → Details). This is safe: the function checks each person's sign-in and team membership itself.
- **Live updates don't appear:** in Supabase, open **Database → Publications → supabase_realtime** and check that `docs`, `activity`, `team_members` and `teams` are enabled. Re-running `schema.sql` turns them on.
