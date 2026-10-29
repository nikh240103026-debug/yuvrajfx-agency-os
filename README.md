# YuvrajFX Agency OS

The operating system for YuvrajFX, a video editing and motion design agency. It covers clients, projects and deliverables, invoices and payments, money reports, the sales pipeline, tasks, a client portal and approval-gated automations. The React frontend and Express API run as one application, with persistent data stored in PostgreSQL.

- **PostgreSQL is the only runtime database.** Use a managed PostgreSQL service for production or a local PostgreSQL server for development.
- **Nothing goes out without you.** No email is sent and no client is contacted automatically. Reminders become drafts that wait for your approval.
- **Figures come from your records.** Every number on the dashboard and in reports is calculated from your own data. Nothing is hardcoded.

---

## 1. Start it

Requirements: **Node.js 24 or newer** and a PostgreSQL database. Set `DATABASE_URL` before starting the app.

**Easiest (Windows):** double-click **`Launch YuvrajFX.cmd`** in this folder.
- On first run it installs dependencies and builds the app.
- It then opens http://127.0.0.1:4747 in your browser.
- Keep the window open while you work; close it to stop the app.
- Double-clicking it again while the app is running just reopens the browser.

**From a terminal:**

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open **http://127.0.0.1:4747**. `npm install` and `npm run build` are only needed the first time and after you change the code; after that, `npm start` is enough.

**First run:** the app shows a setup screen. There you create the owner account (your login), the business name, the base/reporting currency and the timezone. No account exists until you do this. You choose the password; nothing is preset.

**Development mode** (hot reload for UI changes, server restarts when server code changes):

```bash
npm run dev
```

### Try it with demo data

Go to **Settings → Data → Load demo data**, or run `npm run seed:demo` after setup.
- **What it adds:** 6 sample clients in INR, USD and EUR, with projects, deliverables, invoices, payments, expenses, leads, tasks and team members.
- **How it's labelled:** every demo record has a **DEMO** badge, uses `.example` email domains, and a banner stays up while demo data exists.
- **Removing it:** click **Remove demo data** in the banner (or run `npm run demo:remove`). This deletes only demo rows; your own records are untouched.
- **If removal is refused:** this happens when you attached a real project, invoice or payment to a demo client. The message lists them so you can move them first.

---

## 2. Configuration

Copy `.env.example` to `.env`. `DATABASE_URL` is required; other settings are optional. Secrets live only in `.env`, which is git-ignored; none are hardcoded.

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | Address the server listens on. The default keeps the app reachable from this computer only. |
| `PORT` | `4747` | Port for the web app. |
| `DATABASE_URL` | required | PostgreSQL connection string, for example `postgresql://user:password@host:5432/yuvrajfx?sslmode=require`. |
| `COOKIE_SECURE` | `false` | Set to `true` only when the app is served over HTTPS, so session cookies get the Secure flag. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | empty | Outgoing email, used only when you approve a message. With `SMTP_HOST` empty, email is off and drafts wait in the Outbox. |

Command-line port override: `npm start -- --port=5000`. Configure database access with `DATABASE_URL`.

Business settings are stored in the database and edited in the app, under **Settings**:
- business details, address and tax ID label;
- invoice numbering, default payment terms, default taxes (e.g. CGST 9% + SGST 9%), payment instructions and invoice footer;
- reporting currency, exchange rates and timezone;
- logins.

---

## 3. Database

- **Engine:** PostgreSQL only. The application requires `DATABASE_URL` and does not create or fall back to a local database file.
- **Migrations:** the PostgreSQL schema is applied at startup. Run `npm run migrate` to apply migrations without starting the web server.
- **Money:** stored as integer minor units (paise, cents) together with an ISO currency code on every record.
- **Integrity rules:** PostgreSQL constraints and triggers enforce payment/invoice rules, including preventing overpayments, currency/client mismatches, editing recorded payments, reducing invoice totals below payments, and changing paid invoice ownership/currency.
- **Backups:** configure automated backups in your PostgreSQL provider. `npm run backup` and Settings → Data → Download backup use `pg_dump`; the PostgreSQL client utility must be installed on the host.
- **Restoring:** restore a custom-format `.dump` with PostgreSQL's `pg_restore` into a database with the intended schema/version. Never restore over production without a verified backup and a maintenance window.
- **Locked out?** Run `npm run user:create -- --email you@example.com --reset` to generate a one-time password. Change it at next sign-in.

Example local setup: create a PostgreSQL database named `yuvrajfx`, copy `.env.example` to `.env`, set `DATABASE_URL`, then run `npm install`, `npm run build`, and `npm start`.

---

## 4. Logins and permissions

| Role | Sees and does |
|---|---|
| **Owner / Admin** | Everything: money, pipeline, automations, settings and logins. |
| **Team member** | Production only: clients (without retainers, balances or payment terms), projects, deliverables, tasks, calendar, team workload and notifications. Members get 403 on invoices, payments, expenses, finance, leads, automations and settings, and money-related activity is hidden from them. |
| **Client** | The client portal only, and only for their own client account (see below). |

How sign-in is protected:
- **Passwords:** hashed with scrypt. New logins get a one-time password that must be changed at first sign-in.
- **Sessions:** a random token in an HttpOnly, SameSite=Lax cookie. Only its SHA-256 hash is stored. Sessions expire after 30 days of inactivity.
- **Request protection:** every change needs a custom header and a matching Origin (CSRF protection), and the server sends strict security headers (Helmet CSP).
- **Rate limit:** after 10 failed sign-ins for the same email and IP, sign-in is blocked for 15 minutes.

Team logins are created under **Settings → Logins & access**. Client portal logins are created on the client's page, on the **Portal access** tab. Nothing is emailed: you share the one-time password with the person yourself.

---

## 5. Client portal

A client login sees a separate, simpler app:
- their portal-visible projects and each deliverable's progress;
- review links, where they can **leave feedback**, **approve** or **request changes** (which logs a revision);
- final download links;
- their sent invoices with balances, printable.

Your team gets a notification for each client action.

**Isolation:**
- Every portal query is scoped on the server to the client ID in the session, never to an ID sent by the browser.
- Another client's project, deliverable or invoice returns 404, and every staff endpoint returns 403 to client logins.
- Automated tests cover this: `tests/portal.test.ts`.
- Draft invoices, internal notes, other clients' data and your finances never reach the portal.

**Important: the portal is local-only right now.** By default the server listens on `127.0.0.1`, so clients cannot reach it. Giving real clients access over the internet needs:
- an always-on machine or small server;
- HTTPS through a reverse proxy (e.g. Caddy) or a tunnel (e.g. Cloudflare Tunnel);
- `COOKIE_SECURE=true`;
- off-site backups.

It has not been deployed or security-audited for public exposure, so treat that as a separate step (see the roadmap).

---

## 6. What's included

**Dashboard**
- **Money:** MRR (retainers in force, shown as expected income), cash collected this month, outstanding and overdue invoices, monthly expenses and net cash flow.
- **Work:** active clients and projects, deliverables due in the next 7 days, overdue deliverables, tasks and payments.
- **Sales and activity:** weighted pipeline value and a recent-activity feed.
- **Charts:** cash collected, invoiced and expenses over the last 12 months; top clients by cash collected; deliverables by stage. Each chart also has a table view.
- **Lists:** next actions, deliverables due soon, and recent activity.

**Clients (CRM)**
- **Contact details:** contact, company, email, phone/WhatsApp, website, socials, country and timezone.
- **Commercial terms:** service package, retainer with its own currency and billing cycle, contract start and renewal dates, and payment terms.
- **Organising:** status (onboarding, active, paused, churned), tags and notes.
- **History:** a communication log (calls, emails, DMs, meetings) and a full activity timeline.
- **Linked work and money:** projects, deliverables, invoices and portal logins on the client page.
- **Finding clients:** search, filters (status, tag, archived), sorting and CSV export.

**Projects and deliverables**
- **Project types:** short-form, long-form YouTube, video ads, motion graphics, thumbnails and assets, and retainer packs.
- **Project fields:**
  - client;
  - fixed price or retainer allocation, in the client's currency;
  - start date and deadline, priority and status;
  - lead editor;
  - reference and asset links;
  - client portal visibility.
- **Deliverable fields:** format and platform, deadline, assignee, source, review and final links, revision count, estimated hours and notes.
- **Kanban board:** Backlog → Editing → Internal review → Client review → Revisions → Approved → Delivered. Moving a deliverable into Revisions counts a revision round; Approved and Delivered record their dates.
- **Other views:** a list view, and a calendar of deliverable, project and task deadlines plus invoice due dates, renewals and follow-ups.
- **Overdue highlighting** happens automatically; on-hold projects are excluded.
- **Feedback and revision history:** kept for each deliverable, from the team or from the client portal.
- **Team page:** capacity and workload per editor (booked hours for the next 7 days, open, due and overdue work), plus cost rates (visible to admins only).

**Invoices and payments**
- **Line items:** quantity, rate and service type, with a percentage or fixed discount and any number of tax lines. Each invoice is in a single currency.
- **Statuses:** draft, sent, partially paid, paid, overdue and void.
  - Status is calculated from the recorded payments and the due date.
  - An invoice is **paid only when recorded payments cover the full total**; the database refuses overpayment.
- **Payments:**
  - **Recording:** partial and full payments with method (bank, UPI, PayPal, Wise, Payoneer, Stripe, cash) and reference; balances update automatically.
  - **Payment history:** searchable and filterable.
- **Retainer invoices:** one click drafts this period's invoice for each active retainer client who is due one (never twice for the same period). They stay drafts until you review and send them.
- **Output:** printable invoices (use the browser's "Save as PDF") and CSV export of invoices and payments.

**Finance and reports**
- **Totals:** invoiced vs collected vs receivables, expenses (by category), net cash flow and estimated profit, all per currency.
- **Breakdowns:** revenue by client, service and month, plus MRR.
- **Reports:** monthly, quarterly, annual or custom range, printable and exportable as CSV. While the app is running, monthly and weekly snapshots are saved automatically.
- **Currency rules:**
  - Currencies are **never added together**.
  - If you enter your own exchange rates, an extra "≈ combined" estimate appears, clearly marked as approximate. Rates are never fetched online and never change recorded amounts.
- **Actual vs forecast:**
  - Actual cash is only what has been recorded as paid.
  - Retainers count as MRR (expected), never as collected cash.
  - Pipeline value is a separate, probability-weighted forecast.
- **Expenses:** an expense log with categories, receipts as links, and CSV export.

**Sales pipeline**
- **Stages:** Lead → Contacted → Replied → Discovery call → Proposal sent → Negotiation → Won / Lost, on a board or a table.
- **Prospect fields:** contact name, company, email, phone, website, social link, source, deal type, estimated value and currency, next follow-up date, notes, stage history, and the won/lost reason.
- **Follow-ups:** reminders for prospects that are due or overdue. Logging outreach updates the last-contact date.
- **Duplicate detection:** checks against existing leads *and* clients, by email, website, company, phone or social link (and by name when neither side has a company). It warns live while you type and on import; you can override it explicitly.
- **Reports:**
  - a stage funnel with stage-to-stage conversion rates;
  - win rate, won value and average days to close;
  - a win/loss report by source and by reason;
  - pipeline value per currency, weighted by each stage's win probability.
- **Won leads:** one-click conversion of a won lead into a client.
- **CSV:**
  - **Import:** a preview flags duplicates and invalid rows before anything is saved.
  - **Export:** the full lead list.
- **No outreach:** nothing in the pipeline sends messages.

**Tasks and notifications**
- **Task fields:** linked client, project or lead, plus priority, assignee, due date and status.
- **Views:** Today, Upcoming, Overdue and Done, plus quick add.
- **Recurring rules:** tasks or whole projects (copied with their deliverables) repeating daily, weekly, monthly, quarterly or yearly.
  - If the app was off for a long time, missed runs are skipped instead of piling up.
- **Notification center:** read and unread states and a bell counter.
- **Search:** Ctrl+K finds clients, projects, deliverables, tasks, invoices and leads. Invoices and leads show for admins only.

**Automations** (run on start-up, then every 15 minutes while the app is running; each run is idempotent and logged):

| Automation | What it does |
|---|---|
| Deadline reminders | Deliverables and projects due soon; overdue deliverables and tasks |
| Overdue invoice reminders | Flags overdue invoices and **drafts** a reminder email for your approval |
| Client renewal reminders | Before a contract renews, plus a follow-up task |
| Sales follow-ups | Prospect follow-ups that are due or overdue |
| Recurring tasks & projects | Creates what your recurring rules schedule |
| Monthly revenue summary | Saved on the 1st (optionally drafted as an email to you) |
| Weekly business report | Saved every Monday (optionally drafted as an email to you) |

Each automation can be switched on or off and run on demand. Every email lands in **Automations → Outbox**, where you can:
- **Approve & send** (only when SMTP is configured, and only after a confirmation);
- **Open in mail app**, which opens a prefilled email in your own mail program;
- **Copy** the text;
- **Mark as sent** if you sent it some other way;
- **Discard** it.

---

## 7. Testing

```bash
npm test
```

The integration suite requires `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database named `yuvraj_agency_test`; it creates isolated schemas for app tests. Never point this variable at production. They cover:
- **Money:** maths and rounding, including tax, discount and fractional-quantity cases, and never adding currencies together.
- **Invoices:** totals, sequential numbers, validation, partial and full payments, "paid only when covered", no overpayment, overdue in the business timezone, void and duplicate, retainer drafts, CSV.
- **Finance:** collected vs invoiced vs receivables vs expenses kept separate per currency, revenue breakdowns, labelled FX estimates, and dashboard metrics calculated from the data.
- **Clients and projects:** create, validate, edit, search and filter; the communication log and timeline; archiving; stage moves with revision counting; overdue filters.
- **Pipeline:** duplicate detection against leads and clients, weighted value, conversion and win/loss figures, lead-to-client conversion, and CSV import and export.
- **Tasks:** today, overdue and upcoming views, plus recurring tasks and projects (once per occurrence, with no flood after long gaps).
- **Automations:** reminders and snapshots run once per occurrence; overdue-invoice emails are drafted for approval and never sent on their own.
- **CSV and dates:** parsing and escaping (spreadsheet-formula injection is neutralised), month-end clamping, and the business timezone.
- **Auth:** sessions, CSRF and the rate limit.
- **Permissions and isolation:** member finance redaction, plus portal isolation between two clients.
- **Demo data:** load and remove, including the conflict check.
- **Smoke test:** every read endpoint against the full demo dataset.

```bash
npm run typecheck
```

This runs TypeScript over the whole project. It runs single-threaded to fit in low memory. If it crashes with "cannot allocate memory" while heavy apps are open, close something or retry; setting `GOMEMLIMIT=700MiB` for the command also helps.

The main workflows were also run end to end in a browser against a throwaway PostgreSQL schema:
- first-run setup and demo data;
- creating and editing a client;
- creating and editing a project with deliverables, board moves and revision counting;
- an invoice with a discount, sent and then partially paid;
- CSV lead import with duplicate and error rows;
- an automation run producing an outbox draft;
- the client portal: forced password change, request changes, invoice view, and the cross-client 404/403 probes;
- settings and exchange rates;
- Ctrl+K search;
- every page at phone width (375 px) without sideways scrolling.

---

## 8. Integrations: what's not connected

| Integration | Status |
|---|---|
| **Email (SMTP)** | Built in. Off until you set `SMTP_*`, and then only on "Approve & send". Tested with a recording mailer only; **never tried against a real mail server**, so send yourself a test first. |
| **Online payments** (Stripe, Razorpay, PayPal links) | Not built, on purpose: payments are recorded by hand, and payment collection needs your explicit go-ahead. The method names are labels only. |
| **File storage and video review** (Frame.io, Drive, Dropbox) | No uploads. Deliverables store links to wherever the files live. |
| **Calendar sync** (Google Calendar, iCal) | Not built. Use the in-app calendar. |
| **Chat notifications** (WhatsApp, Slack, Discord) | Not built. Notifications are in-app only. |
| **Exchange rates** | Entered by you; nothing is fetched online. |
| **PDF invoices** | Through the browser's print dialog ("Save as PDF"); no server-side PDF. |
| **Hosting** | None. The app runs locally, and the portal is not reachable from the internet (see section 5). |
| **Password reset by email, 2FA** | Not built. Passwords are reset with the command-line script in section 3. |

---

## 9. Roadmap (in priority order)

1. **Make the portal reachable for real clients, safely.**
   - Run the app on an always-on machine or a small VPS behind HTTPS (Caddy or Cloudflare Tunnel), with `COOKIE_SECURE=true`.
   - Add automatic off-site backups.
   - Review security before inviting clients.
2. **Turn on real email.**
   - Set up SMTP (e.g. Postmark, Resend or a Google Workspace app password) and send a test to yourself.
   - Then add portal invite emails and email-based password reset.
3. **Add sign-in hardening:** 2FA for owner and admin logins, a viewer for login activity, and session management (sign out other devices).
4. **Add payment links (only with your approval):** Stripe or Razorpay links on invoices, with a webhook that records the payment. The existing database guards would still apply.
5. **Improve video review:** Frame.io or Google Drive previews with time-coded comments, and uploads of finals.
6. **Track time per deliverable**, to get real profitability per client and project using the team cost rates already stored.
7. **Add an iCal feed** of deadlines for Google or Apple Calendar.
8. **Send digests and alerts** by email, Slack or WhatsApp, approval-gated where they reach clients.
9. **Add India tax details:** SAC codes, place of supply and LUT export notes on invoices, plus GST reports.
10. **Make it installable** (PWA) so it works like a phone app.

---

## Project layout

```
src/server/   Express API: routes/, services/ (invoices, finance, pipeline, automations…), db/ (schema + migrations), lib/ (auth, validation, csv)
src/shared/   Code used by both sides: money maths, dates, constants
src/web/      React app: pages/, components/, portal/
scripts/      build, migrate, demo load/remove, user create/reset, backup
tests/        Vitest + Supertest suites
data/         Local backup dumps (git-ignored)
```

Stack: Node 24 (native TypeScript, PostgreSQL via `pg`), Express 5, React 19, React Router, TanStack Query, Tailwind CSS 4, Vite, Zod, Vitest.
