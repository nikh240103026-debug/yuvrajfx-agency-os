import { useState, type KeyboardEvent } from 'react';
import { Link2, Plus, Trash2, X } from 'lucide-react';
import { Button, IconButton, Input } from './ui.tsx';
import { hostOf, safeHref } from '../lib/util.ts';

export function TagInput({ value, onChange, placeholder = 'Add a tag and press Enter', suggestions = [], id }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; id?: string }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/,+$/, '');
    if (!t || value.includes(t) || t.length > 40) return;
    onChange([...value, t]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const listId = id ? `${id}-suggestions` : undefined;
  return (
    <div className="field-input !h-auto min-h-9 flex flex-wrap items-center gap-1.5 !py-1.5">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-accent-soft text-accent-ink text-[12px]">
          {t}
          <button type="button" aria-label={`Remove ${t}`} className="hover:text-ink cursor-pointer" onClick={() => onChange(value.filter((x) => x !== t))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft && add(draft)}
        placeholder={value.length ? '' : placeholder}
        className="flex-1 min-w-24 bg-transparent outline-none text-[13.5px] placeholder:text-ink-3/70"
      />
      {listId && (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

export type LinkItem = { label: string; url: string };

export function LinkListEditor({ value, onChange, placeholder = 'https://…' }: { value: LinkItem[]; onChange: (v: LinkItem[]) => void; placeholder?: string }) {
  const update = (i: number, patch: Partial<LinkItem>) => onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="flex flex-col gap-2">
      {value.map((l, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_auto] gap-2">
          <Input value={l.label} placeholder="Label" aria-label="Link label" onChange={(e) => update(i, { label: e.target.value })} />
          <Input value={l.url} placeholder={placeholder} aria-label="Link URL" onChange={(e) => update(i, { url: e.target.value })} />
          <IconButton label="Remove link" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { label: '', url: '' }])}>
          Add link
        </Button>
      </div>
    </div>
  );
}

export function LinkChips({ links, empty = 'No links yet.' }: { links: LinkItem[]; empty?: string }) {
  if (!links.length) return <p className="text-[12.5px] text-ink-3">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-2">
      {links.map((l) => {
        const href = safeHref(l.url);
        return (
          <li key={l.url + l.label}>
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-white/[0.04] ring-1 ring-inset ring-white/[0.07] text-[12.5px] text-ink-2 hover:text-ink hover:bg-white/[0.07]"
            >
              <Link2 className="size-3.5 text-ink-3" aria-hidden />
              {l.label || hostOf(l.url)}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** External link that only renders when the URL is a safe http(s) link. */
export function ExtLink({ url, children, className }: { url: string | null | undefined; children?: React.ReactNode; className?: string }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className ?? 'text-accent-ink hover:underline'}>
      {children ?? hostOf(href)}
    </a>
  );
}
