import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError } from '../api'
import { Button } from '../components/ui/button'
import { Card, CardHeading } from '../components/ui/card'
import { useSession, checkoutKey } from '../session'
import { isProviderUrl } from '../components/PaymentDialog'
import type { Cart, PaymentDetail, PaymentSummary } from '../model'

interface RetryIntent { user_id: number; cart_id: number; scenario: null; key: string; payment_id?: number }

function uncertainRetryKey(userId: number, cartId: number): string | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(checkoutKey) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    return row.user_id === userId && row.cart_id === cartId && row.scenario === null && typeof row.key === 'string' && !row.payment_id ? row.key : null
  } catch { localStorage.removeItem(checkoutKey); return null }
}

function money(value: number, currency: string) { return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(value / 100) }

export function PaymentDetailPage() {
  const { paymentId } = useParams()
  const id = Number(paymentId)
  const { api, config, identity } = useSession()
  const navigate = useNavigate()
  const [payment, setPayment] = useState<PaymentDetail | null>(null)
  const [cartStatus, setCartStatus] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<PaymentSummary[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)

  const refresh = useCallback(async () => {
    if (!Number.isSafeInteger(id) || id < 1) { setError('Payment not found.'); setBusy(false); return null }
    setBusy(true)
    try {
      const data = await api.get<PaymentDetail>(`/v1/payments/${id}`)
      setPayment(data)
      const cart = await api.get<Pick<Cart, 'status' | 'payments'>>(`/v1/carts/${data.cart_id}`)
      setCartStatus(cart.status)
      setAttempts(cart.payments)
      setError('')
      return data
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 404 ? 'Payment not found or you do not have access.' : reason instanceof Error ? reason.message : 'Payment unavailable.')
      return null
    } finally { setBusy(false) }
  }, [api, id])

  useEffect(() => { void refresh() }, [refresh])

  async function retry() {
    if (!payment || !identity || !['failed', 'cancelled'].includes(payment.status) || cartStatus !== 'checked_out') return
    setBusy(true)
    setError('')
    const key = uncertainRetryKey(identity.user.id, payment.cart_id) ?? crypto.randomUUID()
    const intent: RetryIntent = { user_id: identity.user.id, cart_id: payment.cart_id, scenario: null, key }
    localStorage.setItem(checkoutKey, JSON.stringify(intent))
    try {
      const result = await api.post<PaymentSummary>('/v1/cart/checkout', { cart_id: payment.cart_id }, { headers: { 'Idempotency-Key': key } })
      localStorage.setItem(checkoutKey, JSON.stringify({ ...intent, payment_id: result.id, reference: result.reference }))
      if (result.payment_url && !isProviderUrl(result.payment_url, config.PROVIDER_ORIGIN)) throw new Error('The provider returned a URL outside its configured origin.')
      navigate('/products')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Retry could not be started.') }
    finally { setBusy(false) }
  }

  return <div className="space-y-5">
    <div><Link className="text-sm font-semibold text-sky-900 underline" to="/payments">← Payments</Link><h1 className="mt-2 text-3xl font-extrabold">Payment details</h1></div>
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-900">{error} <Button variant="outline" className="ml-2" onClick={() => void refresh()}>Retry</Button></p>}
    {busy ? <p role="status">Loading payment…</p> : payment && <>
      <Card><CardHeading>{payment.reference}</CardHeading><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm text-slate-600">Status</dt><dd className="text-lg font-bold capitalize">{payment.status}</dd></div><div><dt className="text-sm text-slate-600">Amount</dt><dd className="font-semibold">{money(payment.amount_minor, payment.currency)}</dd></div><div><dt className="text-sm text-slate-600">Created</dt><dd>{new Date(payment.created_at).toLocaleString()}</dd></div><div><dt className="text-sm text-slate-600">Scenario</dt><dd>{payment.failure_scenario_code ?? 'Standard'}</dd></div><div><dt className="text-sm text-slate-600">Fulfilment</dt><dd>{payment.fulfillment ? `Completed ${new Date(payment.fulfillment.created_at).toLocaleString()}` : 'Not fulfilled'}</dd></div></dl>
        {payment.status === 'pending' && <div className="mt-4"><p role="status">Payment is pending. Refresh to fetch its latest API-confirmed state.</p>{payment.payment_url && <a className="mt-2 inline-block underline" href={isProviderUrl(payment.payment_url, config.PROVIDER_ORIGIN) ? payment.payment_url : undefined} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open provider checkout in a new tab</a>}<Button variant="outline" className="ml-3" onClick={() => void refresh()}>Refresh status</Button></div>}
        {['failed', 'cancelled'].includes(payment.status) && cartStatus === 'checked_out' && <Button className="mt-4" disabled={busy} onClick={() => void retry()}>{busy ? 'Starting retry…' : 'Retry payment with a new key'}</Button>}
      </Card>
      <Card><CardHeading>Items</CardHeading><ul className="divide-y divide-slate-200">{payment.cart.items.map((item) => <li key={item.product_id} className="flex justify-between gap-3 py-3"><span>{item.product_name} × {item.quantity}</span><span>{money(item.line_total_minor, item.currency ?? payment.currency)}</span></li>)}</ul></Card>
      <Card><CardHeading>Fulfilment</CardHeading>{payment.fulfillment ? <ul className="divide-y divide-slate-200">{payment.fulfillment.items.map((item) => <li key={item.product_id} className="py-2">{item.product_name} × {item.quantity}</li>)}</ul> : <p>Fulfilment has not been recorded.</p>}</Card>
      <Card><CardHeading>Attempts and incidents</CardHeading><p className="text-sm text-slate-600">Cart #{payment.cart_id}</p><ul className="mt-3 divide-y divide-slate-200">{attempts.map((attempt) => <li key={attempt.id} className="flex flex-wrap justify-between gap-2 py-2"><Link className="underline" to={`/payments/${attempt.id}`}>{attempt.reference}</Link><span className="capitalize">{attempt.status}</span></li>)}</ul>{payment.incidents.length ? <ul className="mt-3 list-disc pl-5">{payment.incidents.map((incident) => <li key={incident.id}>{incident.code} — {incident.redacted_details ?? 'This case requires review.'}</li>)}</ul> : <p className="mt-2">No incident is reported for this payment.</p>}</Card>
    </>}
  </div>
}
