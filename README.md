# Sprint Board — Real-time Collaboration Demo

Express + Socket.IO + PostgreSQL, containerised, deployable to Render in one step.

> **This is a DEMO, not a production-ready internal tool.**
> There is no SSO — anyone with the link can edit the data. **Use mock data only. Do not enter any real client or project information.**
> Before real use it needs: Entra ID authentication, ISRM approval, and a confirmed hosting environment.

---

## Run locally — option A: without Docker (recommended if you have Node + Homebrew)

Docker is only needed to *build the image for Render*. Render builds it on its own
servers, so you do **not** need Docker installed to develop or to deploy.

**1. Install and start Postgres**

```bash
brew install postgresql@16
brew services start postgresql@16

# Homebrew keeps versioned formulae off the default PATH
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

createdb sprintboard
```

**2. Configure and run**

```bash
cp .env.example .env      # the default DATABASE_URL already matches the step above
npm install
npm start
```

The app creates the schema and loads the seed data automatically on first boot —
there is no separate migration step and `psql` is not required.

Open http://localhost:3000

Use `npm run dev` instead of `npm start` to restart on file changes.

---

## Run locally — option B: with Docker

```bash
docker compose up --build
```

Open http://localhost:3000. Postgres is exposed on host port `5433` to avoid
clashing with a local 5432 install.

To wipe the data and start over:

```bash
docker compose down -v && docker compose up --build
```

---

## Resetting the data

Works with either option:

```bash
npm run db:reset
```

Drops all tables and rebuilds from `schema.sql` + `seed.sql`. Destructive, and
intended only for the demo database.

---

## Two-person live test

This is the core scenario to demo. Use **a normal window plus an incognito window** — they have separate sessionStorage, so they count as two different people.

1. Normal window: open http://localhost:3000, enter the name `Kevin`
2. Incognito window: same address, enter the name `Alice`
3. **Online now** in the sidebar should show two avatars in both windows
4. Then walk through:

| Action | Expected |
|---|---|
| Alice changes Owner / Reviewer / Status | Kevin's row updates immediately and flashes amber |
| Alice drags the Progress slider | Syncs to Kevin on release; no requests fire mid-drag |
| Alice changes an ETA | Board, Timeline and Calendar all update together |
| Alice adds a Meeting | It appears on Kevin's Calendar immediately |
| Alice adds a Milestone | A diamond appears on the Timeline and a ◆ entry on the Calendar |
| **Both edit the same field at once** | The second writer gets an amber notice ("Modified by Alice"), and the row refreshes to the latest values — **no silent lost update** |

That last row is the important one. Socket.IO only makes you see other people's changes sooner; **conflicts are resolved by the `version` optimistic lock.**

---

## Deploy to Render

1. Push the code to GitHub
2. Render → **New > Blueprint** → select this repo (it reads `render.yaml` and creates the web service plus Postgres)
3. Open `https://<your-service>.onrender.com`

That is the whole process. The app detects the empty database on first boot and
creates the schema and seed data itself, so there is no `psql` step and no need
for shell access on the instance.

### Two hard limits on the free tier

- **Free web services sleep after 15 minutes idle**, with a 30–60 second cold start. **Open the URL once to warm it up before a demo.** For a formal demo, consider temporarily upgrading to a paid instance.
- **Free Postgres expires 30 days after creation.** There is then a 14-day grace period to upgrade to a paid instance; after that the database and all its data are deleted. The free tier has **no backups**, and Render may restart or perform maintenance on it at any time.

In other words this demo will not survive a month. That suits its purpose — but don't let it become something the team actually relies on.

---

## Architecture

```
Browser ──HTTP PATCH──> Express ──> Postgres (version optimistic lock)
   ↑                        │
   └───── Socket.IO ────────┘   (broadcast only, never writes)
```

**All writes go over HTTP; the socket only notifies.** That preserves status codes, curl-based debugging and retry semantics. Pushing writes through the socket would make failures much harder to diagnose.

### Optimistic locking

Every table has a `version` column. Updates run as:

```sql
UPDATE tasks SET ..., version = version + 1
 WHERE id = $x AND version = $expected
```

Zero rows returned → HTTP **409** plus the server's current row → the client shows a notice and refreshes.

### Field-level updates

`PATCH` rather than `PUT`: the body carries only the changed fields, so two people editing different fields of the same record don't conflict.

### Activity log

The `activity` table is append-only and records old/new/actor for every field change. It backs the Activity section at the bottom of the task drawer.

---

## Demo → production: the one big change

Search the code for **`REPLACE-WITH-SSO`** (a single spot, in `server/index.js`).

Identity today is just a display name the client puts in an `X-Actor` header — **anyone can forge it; this is not authentication.** Production must take identity from a verified OIDC token instead:

- **Azure App Service**: enable Easy Auth + Entra ID, essentially no code
- **AWS**: ALB built-in OIDC, or Auth.js with an Entra provider inside the app

Both require IT to register an application in BCG's Entra tenant. **This is the only dependency you cannot progress on your own, so raise the ticket early.**

The app itself is a standard Docker container against standard Postgres, so moving from Render to ECS Fargate or Azure App Service means changing environment variables, not code.

---

## Layout

```
├── docker-compose.yml   local: app + postgres
├── Dockerfile           non-root user, cacheable dependency layer
├── render.yaml          Render Blueprint
├── db/
│   ├── schema.sql       four tables, all carrying `version`
│   └── seed.sql         mock data
├── scripts/
│   └── reset-db.js      npm run db:reset
├── server/
│   ├── index.js         Express + Socket.IO + actor middleware
│   ├── env.js           dependency-free .env loader
│   ├── db.js            pool, auto-migration, optimistic-locked updates
│   └── routes/crud.js   CRUD factory shared by all three tables
└── public/
    ├── index.html       five views + name gate + demo banner
    ├── app.css          single-pass token system
    └── app.js           rendering, inline edit, socket, 409 handling
```

## What was done for security

- **Field whitelist** (`EDITABLE` in `db.js`): any field not on the list is rejected, and keys from `req.body` are never interpolated into SQL
- **Parameterised queries throughout** — no string concatenation
- Output escaped consistently for `< > & " '`
- Container runs as a non-root user
- Request body capped at 256kb
- Credentials only via environment variables; `.env` is in both `.gitignore` and `.dockerignore`

**What was not done:** authentication, authorisation, rate limiting, CSRF. These belong with the SSO work.
