import type { Db } from './db.ts';

export type Migration = { version: number; name: string; sql: string };

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

// Append new migrations to the end; never edit one that has shipped.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE team_members (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT,
  title           TEXT NOT NULL DEFAULT 'Editor',
  skills          TEXT NOT NULL DEFAULT '[]',
  capacity_hours  REAL NOT NULL DEFAULT 40 CHECK (capacity_hours >= 0),
  cost_rate_minor INTEGER CHECK (cost_rate_minor IS NULL OR cost_rate_minor >= 0),
  cost_currency   TEXT,
  cost_unit       TEXT CHECK (cost_unit IS NULL OR cost_unit IN ('hour','video','project','month')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  color           TEXT,
  notes           TEXT,
  is_demo         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT ${NOW},
  updated_at      TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE clients (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  company            TEXT,
  email              TEXT,
  phone              TEXT,
  whatsapp           TEXT,
  other_contact      TEXT,
  website            TEXT,
  socials            TEXT NOT NULL DEFAULT '{}',
  billing_address    TEXT,
  tax_id             TEXT,
  country            TEXT,
  timezone           TEXT,
  service_package    TEXT,
  retainer_minor     INTEGER CHECK (retainer_minor IS NULL OR retainer_minor >= 0),
  currency           TEXT NOT NULL DEFAULT 'USD',
  billing_cycle      TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','quarterly','yearly')),
  billing_day        INTEGER CHECK (billing_day IS NULL OR billing_day BETWEEN 1 AND 28),
  contract_start     TEXT,
  renewal_date       TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 7 CHECK (payment_terms_days BETWEEN 0 AND 365),
  payment_terms_note TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding','active','paused','completed','churned')),
  tags               TEXT NOT NULL DEFAULT '[]',
  notes              TEXT,
  is_demo            INTEGER NOT NULL DEFAULT 0,
  archived_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  updated_at         TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX clients_status ON clients(status);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('owner','admin','member','client')),
  client_id            INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  team_member_id       INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled             INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  updated_at           TEXT NOT NULL DEFAULT ${NOW},
  -- Portal users always belong to exactly one client; staff never do.
  CHECK ((role = 'client' AND client_id IS NOT NULL) OR (role <> 'client' AND client_id IS NULL))
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE leads (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  company               TEXT,
  email                 TEXT,
  phone                 TEXT,
  website               TEXT,
  social_url            TEXT,
  source                TEXT NOT NULL DEFAULT 'other',
  deal_type             TEXT NOT NULL DEFAULT 'retainer' CHECK (deal_type IN ('retainer','one_time')),
  estimated_value_minor INTEGER CHECK (estimated_value_minor IS NULL OR estimated_value_minor >= 0),
  currency              TEXT NOT NULL DEFAULT 'USD',
  stage                 TEXT NOT NULL DEFAULT 'lead'
                        CHECK (stage IN ('lead','contacted','replied','discovery_call','proposal_sent','negotiation','won','lost')),
  stage_changed_at      TEXT NOT NULL DEFAULT ${NOW},
  last_contact_at       TEXT,
  next_follow_up        TEXT,
  notes                 TEXT,
  outcome_reason        TEXT,
  closed_at             TEXT,
  client_id             INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  tags                  TEXT NOT NULL DEFAULT '[]',
  is_demo               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT ${NOW},
  updated_at            TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX leads_stage ON leads(stage);
CREATE INDEX leads_follow_up ON leads(next_follow_up);

CREATE TABLE lead_stage_history (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX lead_stage_history_lead ON lead_stage_history(lead_id);

-- Communication log for clients and prospects (calls, emails, DMs…). Logging only: nothing is sent from here.
CREATE TABLE communications (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email','call','meeting','whatsapp','dm','note','other')),
  direction   TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound','internal')),
  subject     TEXT,
  body        TEXT,
  occurred_at TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  CHECK (client_id IS NOT NULL OR lead_id IS NOT NULL)
);
CREATE INDEX communications_client ON communications(client_id, occurred_at);
CREATE INDEX communications_lead ON communications(lead_id, occurred_at);

CREATE TABLE recurring_rules (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('task','project')),
  title             TEXT NOT NULL,
  frequency         TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly','yearly')),
  interval          INTEGER NOT NULL DEFAULT 1 CHECK (interval BETWEEN 1 AND 52),
  weekday           INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),
  month_day         INTEGER CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
  start_date        TEXT NOT NULL,
  end_date          TEXT,
  next_occurrence   TEXT NOT NULL,
  lead_days         INTEGER NOT NULL DEFAULT 0 CHECK (lead_days BETWEEN 0 AND 60),
  template          TEXT NOT NULL DEFAULT '{}',
  active            INTEGER NOT NULL DEFAULT 1,
  last_generated_at TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  updated_at        TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE projects (
  id                INTEGER PRIMARY KEY,
  client_id         INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  description       TEXT,
  type              TEXT NOT NULL CHECK (type IN ('short_form','long_form','ad','motion_graphics','thumbnail','other')),
  billing_type      TEXT NOT NULL DEFAULT 'fixed' CHECK (billing_type IN ('fixed','retainer','hourly')),
  price_minor       INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  currency          TEXT NOT NULL,
  start_date        TEXT,
  deadline          TEXT,
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status            TEXT NOT NULL DEFAULT 'backlog'
                    CHECK (status IN ('backlog','editing','internal_review','client_review','revisions','approved','delivered','on_hold','cancelled')),
  editor_id         INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  reference_links   TEXT NOT NULL DEFAULT '[]',
  asset_links       TEXT NOT NULL DEFAULT '[]',
  portal_visible    INTEGER NOT NULL DEFAULT 1,
  recurring_rule_id INTEGER REFERENCES recurring_rules(id) ON DELETE SET NULL,
  recurrence_key    TEXT UNIQUE,
  completed_at      TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  archived_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  updated_at        TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX projects_client ON projects(client_id);
CREATE INDEX projects_status ON projects(status);

CREATE TABLE deliverables (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  format          TEXT,
  platform        TEXT,
  deadline        TEXT,
  status          TEXT NOT NULL DEFAULT 'backlog'
                  CHECK (status IN ('backlog','editing','internal_review','client_review','revisions','approved','delivered')),
  assignee_id     INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  source_url      TEXT,
  review_url      TEXT,
  final_url       TEXT,
  revision_count  INTEGER NOT NULL DEFAULT 0 CHECK (revision_count >= 0),
  estimated_hours REAL CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  notes           TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  approved_at     TEXT,
  delivered_at    TEXT,
  is_demo         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT ${NOW},
  updated_at      TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX deliverables_project ON deliverables(project_id);
CREATE INDEX deliverables_status_deadline ON deliverables(status, deadline);

-- Feedback and revision history. internal_note rows and visible_to_client = 0 never reach the portal.
CREATE TABLE feedback (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deliverable_id    INTEGER REFERENCES deliverables(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('comment','revision_request','approval','internal_note')),
  author_type       TEXT NOT NULL CHECK (author_type IN ('team','client')),
  author_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name       TEXT NOT NULL,
  body              TEXT NOT NULL,
  timecode          TEXT,
  revision_number   INTEGER,
  visible_to_client INTEGER NOT NULL DEFAULT 1,
  resolved_at       TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  CHECK (kind <> 'internal_note' OR visible_to_client = 0)
);
CREATE INDEX feedback_project ON feedback(project_id, created_at);
CREATE INDEX feedback_deliverable ON feedback(deliverable_id, created_at);

CREATE TABLE invoices (
  id                   INTEGER PRIMARY KEY,
  number               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  client_id            INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  project_id           INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  kind                 TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','retainer')),
  currency             TEXT NOT NULL,
  issue_date           TEXT NOT NULL,
  due_date             TEXT NOT NULL,
  period_start         TEXT,
  period_end           TEXT,
  state                TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','sent','void')),
  discount_type        TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','fixed')),
  discount_percent     REAL NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_fixed_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_fixed_minor >= 0),
  taxes                TEXT NOT NULL DEFAULT '[]',
  subtotal_minor       INTEGER NOT NULL DEFAULT 0,
  discount_minor       INTEGER NOT NULL DEFAULT 0,
  tax_minor            INTEGER NOT NULL DEFAULT 0,
  total_minor          INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  notes                TEXT,
  terms                TEXT,
  internal_notes       TEXT,
  sent_at              TEXT,
  voided_at            TEXT,
  void_reason          TEXT,
  portal_visible       INTEGER NOT NULL DEFAULT 1,
  is_demo              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT ${NOW},
  updated_at           TEXT NOT NULL DEFAULT ${NOW},
  CHECK (due_date >= issue_date)
);
CREATE INDEX invoices_client ON invoices(client_id);
CREATE INDEX invoices_issue ON invoices(issue_date);
-- One live retainer invoice per client per service period.
CREATE UNIQUE INDEX invoices_retainer_period ON invoices(client_id, period_start) WHERE kind = 'retainer' AND state <> 'void';

CREATE TABLE invoice_items (
  id               INTEGER PRIMARY KEY,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,
  quantity         REAL NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor >= 0),
  service_type     TEXT NOT NULL DEFAULT 'other',
  sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency     TEXT NOT NULL,
  paid_at      TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT 'bank_transfer',
  reference    TEXT,
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX payments_invoice ON payments(invoice_id);
CREATE INDEX payments_paid_at ON payments(paid_at);

-- Database-level guarantees behind "never mark an invoice paid unless payments cover it":
-- payments can't exceed the balance, can't change currency, and a total can't drop below what was paid.
CREATE TRIGGER payments_guard BEFORE INSERT ON payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_INVOICE_VOID')
    WHERE (SELECT state FROM invoices WHERE id = NEW.invoice_id) = 'void';
  SELECT RAISE(ABORT, 'PAYMENT_CURRENCY_MISMATCH')
    WHERE NEW.currency <> (SELECT currency FROM invoices WHERE id = NEW.invoice_id);
  SELECT RAISE(ABORT, 'PAYMENT_CLIENT_MISMATCH')
    WHERE NEW.client_id <> (SELECT client_id FROM invoices WHERE id = NEW.invoice_id);
  SELECT RAISE(ABORT, 'PAYMENT_EXCEEDS_BALANCE')
    WHERE NEW.amount_minor > (SELECT total_minor FROM invoices WHERE id = NEW.invoice_id)
                           - (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE invoice_id = NEW.invoice_id);
END;

CREATE TRIGGER payments_immutable BEFORE UPDATE OF invoice_id, client_id, amount_minor, currency ON payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_IMMUTABLE');
END;

CREATE TRIGGER invoices_total_covers_payments BEFORE UPDATE OF total_minor ON invoices
BEGIN
  SELECT RAISE(ABORT, 'INVOICE_TOTAL_BELOW_PAID')
    WHERE NEW.total_minor < (SELECT COALESCE(SUM(amount_minor), 0) FROM payments WHERE invoice_id = NEW.id);
END;

CREATE TRIGGER invoices_locked_when_paid BEFORE UPDATE OF currency, client_id, state ON invoices
WHEN EXISTS (SELECT 1 FROM payments WHERE invoice_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'INVOICE_HAS_PAYMENTS')
    WHERE NEW.currency <> OLD.currency OR NEW.client_id <> OLD.client_id OR NEW.state <> 'sent';
END;

CREATE VIEW invoice_balances AS
SELECT i.*,
       COALESCE(p.paid_minor, 0)                 AS paid_minor,
       i.total_minor - COALESCE(p.paid_minor, 0) AS balance_minor,
       COALESCE(p.payment_count, 0)              AS payment_count,
       p.last_paid_at                            AS last_paid_at
FROM invoices i
LEFT JOIN (
  SELECT invoice_id, SUM(amount_minor) AS paid_minor, COUNT(*) AS payment_count, MAX(paid_at) AS last_paid_at
  FROM payments GROUP BY invoice_id
) p ON p.invoice_id = i.id;

CREATE TABLE expenses (
  id             INTEGER PRIMARY KEY,
  date           TEXT NOT NULL,
  category       TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL,
  description    TEXT NOT NULL,
  vendor         TEXT,
  client_id      INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  team_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  receipt_url    TEXT,
  notes          TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT ${NOW},
  updated_at     TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX expenses_date ON expenses(date);

CREATE TABLE tasks (
  id                INTEGER PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  priority          TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  assignee_id       INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
  due_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  completed_at      TEXT,
  recurring_rule_id INTEGER REFERENCES recurring_rules(id) ON DELETE SET NULL,
  recurrence_key    TEXT UNIQUE,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','recurring','automation')),
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  updated_at        TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX tasks_status_due ON tasks(status, due_date);

-- Append-only business activity log (no foreign keys, so history survives deletions).
CREATE TABLE activity (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  client_id   INTEGER,
  project_id  INTEGER,
  action      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  actor_type  TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','client','system')),
  actor_id    INTEGER,
  actor_name  TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX activity_created ON activity(created_at);
CREATE INDEX activity_client ON activity(client_id, created_at);
CREATE INDEX activity_entity ON activity(entity_type, entity_id);

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  audience    TEXT NOT NULL DEFAULT 'admin' CHECK (audience IN ('admin','staff')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  entity_type TEXT,
  entity_id   INTEGER,
  dedupe_key  TEXT UNIQUE,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX notifications_created ON notifications(created_at);

CREATE TABLE notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE automation_settings (
  key         TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config      TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  last_result TEXT
);

CREATE TABLE automation_runs (
  id          INTEGER PRIMARY KEY,
  trigger     TEXT NOT NULL CHECK (trigger IN ('startup','schedule','manual')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  summary     TEXT NOT NULL DEFAULT '{}',
  error       TEXT
);

-- Messages drafted by automations. They are only ever sent after a person approves them.
CREATE TABLE outbox (
  id             INTEGER PRIMARY KEY,
  automation_key TEXT,
  channel        TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  to_address     TEXT NOT NULL,
  to_name        TEXT,
  subject        TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending_approval'
                 CHECK (status IN ('pending_approval','sent','sent_manually','failed','rejected')),
  entity_type    TEXT,
  entity_id      INTEGER,
  client_id      INTEGER,
  dedupe_key     TEXT UNIQUE,
  error          TEXT,
  approved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at    TEXT,
  sent_at        TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT ${NOW},
  updated_at     TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX outbox_status ON outbox(status);

CREATE TABLE report_snapshots (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  data         TEXT NOT NULL,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (kind, period_start)
);
`,
  },
];

export function migrate(db: Db, now: () => string = () => new Date().toISOString()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (:version, :name, :at)', {
        version: m.version,
        name: m.name,
        at: now(),
      });
    });
    ran.push(m.version);
  }
  return ran;
}
