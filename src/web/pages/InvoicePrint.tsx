import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '../lib/api.ts';
import { Button, ErrorState, Spinner } from '../components/ui.tsx';
import { InvoiceDocument, type BusinessProfile, type InvoiceDetail } from '../components/invoice-document.tsx';

/** Full-page invoice for printing or "Save as PDF" in the browser's print dialog. */
export default function InvoicePrintPage({ portal }: { portal?: boolean }) {
  const { id } = useParams();
  const url = portal ? `/api/portal/invoices/${id}` : `/api/invoices/${id}`;
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['invoice-print', url], queryFn: () => api.get<{ invoice: InvoiceDetail; business: BusinessProfile }>(url) });
  useEffect(() => {
    if (data) document.title = `${data.invoice.number} · ${data.business.name}`;
    return () => {
      document.title = 'YuvrajFX · Agency OS';
    };
  }, [data]);
  if (isLoading)
    return (
      <div className="min-h-dvh grid place-items-center">
        <Spinner />
      </div>
    );
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  return (
    <div className="min-h-dvh py-8 px-4 print:p-0 print:bg-white">
      <div className="no-print mx-auto max-w-[820px] mb-4 flex items-center justify-between gap-3">
        <Link to={portal ? '/portal/invoices' : `/invoices/${id}`} className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Back
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-3 hidden sm:inline">Tip: choose “Save as PDF” as the printer to get a PDF.</span>
          <Button variant="primary" icon={<Printer className="size-4" />} onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>
      </div>
      <InvoiceDocument invoice={data.invoice} business={data.business} className="max-w-[820px]" />
    </div>
  );
}
