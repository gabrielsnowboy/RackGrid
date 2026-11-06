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

## 5. Create your team

1. Open RackGrid → **Open Team Workspace** → **Create an account**.
2. Under **Create a team**, enter your organization's name. Tick **Copy my Personal Workspace into this team** to bring over the racks, sites and floor plans you already have.
3. Open **Team & invites** in the sidebar → **Create invitation** and send the link or code to your colleagues.

## Roles

| | Owner | Administrator | Member |
|---|:-:|:-:|:-:|
| View and edit racks, sites, floor plans, wall ports and access points | ✓ | ✓ | ✓ |
| See activity history | ✓ | ✓ | ✓ |
| Invite people (as member or administrator) | ✓ | ✓ | |
| Remove members | ✓ | ✓ (members only) | |
| Rename the team | ✓ | ✓ | |
| Change roles, transfer ownership | ✓ | | |
| Delete the team | ✓ | | |

Each team has one owner. To hand a team over, the owner picks **Make owner…** next to a member and becomes an administrator.

## How syncing works

- Each rack and each site is saved as one versioned record. When two people change the same rack at the same time, RackGrid merges both sets of changes. One person moving a switch while another renames a patch panel keeps both edits. If two people change the very same field, the last save wins.
- Changes from others appear live, usually within a second.
- **Offline:** the team's racks and sites are kept in your browser. If the connection drops you can keep working. Changes are queued on your device and sent when you reconnect. The sidebar shows "Offline · N changes waiting" until they're sent. Floor plans added while offline upload when you're back online.
- The app itself is cached too, so it opens without a connection once you've loaded it before.
- **Activity history** records who changed what (moved, added, removed, connected, patched, renamed…) and when. Changes made offline are recorded when they sync, with the time they were made.

## Troubleshooting

- **"Sync paused"** in the sidebar shows the server's reason, e.g. your account was removed from the team. Click **Retry** after fixing it.
- **Invitation link opens the wrong page:** check that the Site URL and Redirect URLs in step 3 match the address you use.
- **Live updates don't appear:** in Supabase, open **Database → Publications → supabase_realtime** and check that `docs`, `activity`, `team_members` and `teams` are enabled. Re-running `schema.sql` turns them on.
