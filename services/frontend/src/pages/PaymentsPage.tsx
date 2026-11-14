import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { useSession } from '../session'
import type { PageMeta, PaymentSummary } from '../model'

function money(value: number, currency: string) { return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(value / 100) }

export function PaymentsPage() {
  const { api } = useSession()
  const [payments, setPayments] = useState<PaymentSummary[]>([])
  const [meta, setMeta] = useState<PageMeta>({ page: 1, page_size: 20, total: 0 })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setBusy(true)
    api.get<{ data: PaymentSummary[]; meta: PageMeta }>(`/v1/payments?page=${meta.page}&page_size=${meta.page_size}`, { signal: controller.signal, envelope: true })
      .then((response) => { setPayments(response.data); setMeta(response.meta ?? meta); setError('') })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : 'Payment list unavailable.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [api, meta.page, meta.page_size])

  return <div className="space-y-5">
    <div><p className="text-sm font-semibold uppercase tracking-widest text-sky-800">Account</p><h1 className="mt-1 text-3xl font-extrabold">Payments</h1></div>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900">{error} <Button className="ml-2" variant="outline" onClick={() => setMeta({ ...meta })}>Retry</Button></p>}
    {busy ? <p role="status">Loading payments…</p> : payments.length === 0 ? <Card>No payments yet. Start a checkout from Products.</Card> : <Card>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left"><caption className="sr-only">Your payment attempts</caption><thead><tr className="border-b text-sm text-slate-600"><th className="py-3">Reference</th><th>Status</th><th>Amount</th><th>Date</th><th>Fulfilled</th></tr></thead><tbody>
        {payments.map((payment) => <tr key={payment.id} className="border-b last:border-0"><td className="py-3"><Link className="font-semibold text-sky-900 underline" to={`/payments/${payment.id}`}>{payment.reference}</Link></td><td><span className="rounded-full bg-slate-100 px-2 py-1 text-sm capitalize">{payment.status}</span></td><td>{money(payment.amount_minor, payment.currency)}</td><td>{new Date(payment.created_at).toLocaleString()}</td><td>{payment.fulfilled ? 'Yes' : '—'}</td></tr>)}
      </tbody></table></div>
    </Card>}
    <div className="flex items-center justify-between"><span aria-live="polite" className="text-sm text-slate-600">Page {meta.page} · {meta.total} payments</span><div className="flex gap-2"><Button variant="outline" disabled={meta.page <= 1} onClick={() => setMeta({ ...meta, page: meta.page - 1 })}>Previous</Button><Button variant="outline" disabled={meta.page * meta.page_size >= meta.total} onClick={() => setMeta({ ...meta, page: meta.page + 1 })}>Next</Button></div></div>
  </div>
}
