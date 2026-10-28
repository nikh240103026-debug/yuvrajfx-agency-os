import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api.ts';
import { Button, Field, Notice, Select, TextField } from '../components/ui.tsx';
import { CenteredCard, Logo } from '../components/layout.tsx';
import { CurrencySelect } from '../components/money.tsx';
import { useAuth } from '../lib/queries.ts';

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <CenteredCard>
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>
      <div className="card p-6 sm:p-7">
        <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-ink-3">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </CenteredCard>
  );
}

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tz = guessTimezone();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', business_name: 'YuvrajFX', base_currency: 'INR', timezone: TIMEZONES.includes(tz) ? tz : 'Asia/Kolkata' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const { confirm: _c, ...body } = form;
      await api.post('/api/auth/setup', body);
      await qc.invalidateQueries({ queryKey: ['auth'] });
      navigate('/?welcome=1');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(errorMessage(err), 0, null));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Set up your agency workspace" subtitle="Create the owner account. Everything stays on this computer in a local database.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Your name" autoComplete="name" required value={form.name} onChange={(e) => set('name')(e.target.value)} error={error?.field('name')} />
        <TextField label="Email" type="email" autoComplete="email" required value={form.email} onChange={(e) => set('email')(e.target.value)} error={error?.field('email')} />
        <TextField label="Password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters. A short sentence works well." value={form.password} onChange={(e) => set('password')(e.target.value)} error={error?.field('password')} />
        <TextField label="Confirm password" type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => set('confirm')(e.target.value)} error={mismatch ? 'Passwords do not match.' : undefined} />
        <div className="h-px bg-line my-1" />
        <TextField label="Business name" required value={form.business_name} onChange={(e) => set('business_name')(e.target.value)} error={error?.field('business_name')} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reporting currency" hint="Used to order totals. Other currencies are never mixed in.">
            <CurrencySelect value={form.base_currency} onChange={set('base_currency')} />
          </Field>
          <Field label="Timezone" hint="Decides what “today” and “overdue” mean.">
            <Select value={form.timezone} onChange={(e) => set('timezone')(e.target.value)}>
              {[...new Set([form.timezone, ...TIMEZONES])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error && !error.details?.fields && <Notice tone="bad">{error.message}</Notice>}
        <Button type="submit" variant="primary" loading={busy} icon={<ArrowRight className="size-4" />} className="mt-1">
          Create workspace
        </Button>
      </form>
    </Shell>
  );
}

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ user: { role: string } }>('/api/auth/login', { email, password });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      navigate(res.user.role === 'client' ? '/portal' : '/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Sign in" subtitle={data?.business_name ? `${data.business_name} · team and client portal` : undefined}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} icon={<ArrowRight className="size-4" />}>
          Sign in
        </Button>
        <p className="text-[12px] text-ink-3 text-center">Forgot your password? Ask the agency owner to reset it, or run <code className="text-ink-2">npm run user:create -- --email you@… --reset</code> on this computer.</p>
      </form>
    </Shell>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useAuth();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const mismatch = form.confirm.length > 0 && form.confirm !== form.new_password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/change-password', { current_password: form.current_password, new_password: form.new_password });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      setDone(true);
      if (forced) navigate(data?.user?.role === 'client' ? '/portal' : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(errorMessage(err), 0, null));
    } finally {
      setBusy(false);
    }
  };
  const body = (
    <form onSubmit={submit} className="flex flex-col gap-4 max-w-md">
      {forced && (
        <Notice tone="info">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-4" /> You signed in with a temporary password. Choose your own to continue.
          </span>
        </Notice>
      )}
      <TextField label={forced ? 'Temporary password' : 'Current password'} type="password" autoComplete="current-password" required value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} error={error?.field('current_password')} />
      <TextField label="New password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters." value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} error={error?.field('new_password')} />
      <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} error={mismatch ? 'Passwords do not match.' : undefined} />
      {error && !error.details?.fields && <Notice tone="bad">{error.message}</Notice>}
      {done && !forced && <Notice tone="good">Password changed. Other devices were signed out.</Notice>}
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Save new password
        </Button>
      </div>
    </form>
  );
  if (forced) return <Shell title="Choose a new password">{body}</Shell>;
  return (
    <div className="animate-enter">
      <h1 className="text-[22px] font-semibold tracking-tight mb-1">Your account</h1>
      <p className="text-[13.5px] text-ink-3 mb-6">{data?.user?.email}</p>
      <div className="card p-6">{body}</div>
    </div>
  );
}
