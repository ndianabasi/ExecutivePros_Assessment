import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import { PaymentDialog, isProviderUrl, type ActivePayment } from '../components/PaymentDialog'
import { Button } from '../components/ui/button'
import { Card, CardHeading } from '../components/ui/card'
import { usePaymentEvents } from '../events'
import type { Cart, FailureScenario, PageMeta, PaymentDetail, PaymentSummary, Product } from '../model'
import { checkoutKey, useSession } from '../session'

interface Intent { user_id: number; cart_id: number | null; scenario: string | null; key: string; payment_id?: number; reference?: string }
interface CheckoutResponse { id: number; reference: string; status: PaymentSummary['status']; amount_minor: number; currency: string; payment_url: string | null; failure_scenario_code?: string | null; initialisation_state?: string }
const paymentDialogSeenKey = 'executivepros.frontend.payment-dialog-seen.v1'

function storedIntent(userId: number): Intent | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(checkoutKey) ?? 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const row = parsed as Record<string, unknown>
    if (row.user_id !== userId || typeof row.key !== 'string' || row.key.length < 8 || !(row.cart_id === null || Number.isSafeInteger(row.cart_id))) return null
    return row as unknown as Intent
  } catch { localStorage.removeItem(checkoutKey); return null }
}

function hasSeenPaymentDialog(userId: number, paymentId: number) {
  try { return sessionStorage.getItem(paymentDialogSeenKey) === `${userId}:${paymentId}` } catch { return false }
}

function rememberPaymentDialog(userId: number, paymentId: number) {
  try { sessionStorage.setItem(paymentDialogSeenKey, `${userId}:${paymentId}`) } catch { /* Best-effort tab-local reload protection. */ }
}

function makeKey() { return crypto.randomUUID() }
function money(value: number, currency = 'NGN') { return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(value / 100) }
function describeError(error: unknown) { return error instanceof ApiError ? `${error.message} (${error.status})` : error instanceof Error ? error.message : 'Request failed.' }

export function ProductsPage() {
  const { api, config, identity } = useSession()
  const { connection, event, disconnect, reconnect } = usePaymentEvents()
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Cart | null>(null)
  const [meta, setMeta] = useState<PageMeta>({ page: 1, page_size: 20, total: 0 })
  const [scenarios, setScenarios] = useState<FailureScenario[]>([])
  const [scenarioError, setScenarioError] = useState('')
  const [intent, setIntent] = useState<Intent | null>(() => identity ? storedIntent(identity.user.id) : null)
  const [scenario, setScenario] = useState('')
  const [quantity, setQuantity] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activePayment, setActivePayment] = useState<ActivePayment | null>(null)
  const [dismissedPaymentId, setDismissedPaymentId] = useState<number | null>(() => {
    if (!identity) return null
    const saved = storedIntent(identity.user.id)
    return saved?.payment_id && hasSeenPaymentDialog(identity.user.id, saved.payment_id) ? saved.payment_id : null
  })
  const [lastPayment, setLastPayment] = useState<Pick<PaymentSummary, 'id' | 'reference' | 'status'> | null>(null)
  const [responses, setResponses] = useState<string[]>([])
  const abort = useRef<AbortController | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError('')
    const [productResponse, cartResponse] = await Promise.all([
      api.get<{ data: Product[]; meta: PageMeta }>(`/v1/products?page=${meta.page}&page_size=${meta.page_size}`, { ...(signal ? { signal } : {}), envelope: true }),
      api.get<Cart | null>('/v1/cart', signal ? { signal } : {}),
    ])
    setProducts(productResponse.data)
    setMeta(productResponse.meta ?? { ...meta, total: productResponse.data.length })
    setCart(cartResponse)
  }, [api, meta.page, meta.page_size])

  const refreshScenarios = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api.get<FailureScenario[]>('/v1/failure-scenarios', signal ? { signal } : {})
      setScenarios(response)
      setScenarioError('')
    } catch (reason) {
      if (!signal?.aborted) { setScenarioError(describeError(reason)); setScenarios([]) }
    }
  }, [api])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void Promise.all([refresh(controller.signal), refreshScenarios(controller.signal)])
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(describeError(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, refreshScenarios])

  useEffect(() => {
    setScenario(intent?.scenario ?? '')
  }, [intent?.scenario])

  useEffect(() => {
    const paymentId = intent?.payment_id
    if (!paymentId || !identity || activePayment || dismissedPaymentId === paymentId || hasSeenPaymentDialog(identity.user.id, paymentId)) return
    const controller = new AbortController()
    api.get<PaymentDetail>(`/v1/payments/${paymentId}`, { signal: controller.signal })
      .then((payment) => {
        if (payment.status === 'pending' && payment.payment_url && isProviderUrl(payment.payment_url, config.PROVIDER_ORIGIN)) {
          rememberPaymentDialog(identity.user.id, payment.id)
          setDismissedPaymentId(payment.id)
          setActivePayment({ id: payment.id, reference: payment.reference, url: payment.payment_url })
        }
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [activePayment, api, config.PROVIDER_ORIGIN, dismissedPaymentId, identity, intent?.payment_id])

  async function add(product: Product) {
    const count = quantity[product.id] ?? 1
    if (!Number.isSafeInteger(count) || count < 1) { setError('Quantity must be a positive whole number.'); return }
    setBusy(true)
    try {
      const result = await api.post<Cart>('/v1/cart', { items: [{ product_id: product.id, quantity: count }] })
      setCart(result)
      await refresh()
    } catch (reason) { setError(describeError(reason)); await refresh().catch(() => undefined) }
    finally { setBusy(false) }
  }

  async function updateQuantity(productId: number, count: number) {
    if (!Number.isSafeInteger(count) || count < 1) { setError('Quantity must be a positive whole number.'); return }
    setBusy(true)
    try { setCart(await api.patch<Cart>(`/v1/cart/items/${productId}`, { quantity: count })); setError('') }
    catch (reason) { setError(describeError(reason)); await refresh().catch(() => undefined) }
    finally { setBusy(false) }
  }

  async function removeItem(productId: number) {
    setBusy(true)
    try { await api.delete(`/v1/cart/items/${productId}`); await refresh() }
    catch (reason) { setError(describeError(reason)) }
    finally { setBusy(false) }
  }

  async function abandonCart() {
    if (!window.confirm('Abandon this cart?')) return
    setBusy(true)
    try { await api.delete('/v1/cart'); setCart(null); setNotice('Cart abandoned.') }
    catch (reason) { setError(describeError(reason)) }
    finally { setBusy(false) }
  }

  function saveIntent(next: Intent) {
    localStorage.setItem(checkoutKey, JSON.stringify(next))
    setIntent(next)
  }

  async function submitCheckout(options: { key?: string; cartId?: number; abortAfterMs?: number; open?: boolean; allowConcurrent?: boolean; scenario?: string | null } = {}) {
    if (!identity || (busy && !options.allowConcurrent)) return null
    const cartId = options.cartId ?? cart?.id ?? null
    const selectedScenario = options.scenario === undefined ? scenario || null : options.scenario
    const activeIntent = intent?.user_id === identity.user.id && intent.cart_id === cartId && intent.scenario === selectedScenario ? intent : null
    const key = options.key ?? activeIntent?.key ?? makeKey()
    const nextIntent: Intent = { user_id: identity.user.id, cart_id: cartId, scenario: selectedScenario, key }
    saveIntent(nextIntent)
    setLastPayment(null)
    const controller = new AbortController()
    abort.current = controller
    const timeout = options.abortAfterMs ? window.setTimeout(() => controller.abort(), options.abortAfterMs) : undefined
    setBusy(true)
    setError('')
    setNotice(options.abortAfterMs ? 'Sending a timed checkout request. If it times out, retry with the saved key.' : '')
    try {
      const data = await api.post<CheckoutResponse>('/v1/cart/checkout', { ...(cartId ? { cart_id: cartId } : {}), ...(selectedScenario ? { failure_scenario_code: selectedScenario } : {}) }, {
        signal: controller.signal,
        headers: { 'Idempotency-Key': key },
      })
      const saved = { ...nextIntent, payment_id: data.id, reference: data.reference }
      if (data.status === 'success' || data.status === 'failed' || data.status === 'cancelled') {
        localStorage.removeItem(checkoutKey)
        setIntent(null)
        setLastPayment(data)
      } else saveIntent(saved)
      if (options.open !== false) {
        if (data.status === 'failed' || data.status === 'cancelled') {
          setActivePayment(null)
          setNotice(`Payment ${data.reference} is ${data.status}. Review payment details before retrying.`)
        } else if (data.status === 'success') {
          setActivePayment(null)
          setNotice(`Payment ${data.reference} is confirmed successful by the API.`)
        } else if (data.payment_url && isProviderUrl(data.payment_url, config.PROVIDER_ORIGIN)) {
          rememberPaymentDialog(identity.user.id, data.id)
          setDismissedPaymentId(data.id)
          setActivePayment({ id: data.id, reference: data.reference, url: data.payment_url })
          setNotice('Payment is ready in the secure mock-provider dialog.')
        } else {
          setActivePayment(null)
          setNotice(`Payment ${data.reference} is initializing. Refresh payment status or retry checkout with the same key.`)
        }
      }
      return data
    } catch (reason) {
      if (controller.signal.aborted) setNotice('Checkout request was stopped. The API may already have accepted it; retry with the saved key.')
      else setError(describeError(reason))
      return null
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout)
      if (abort.current === controller) abort.current = null
      setBusy(false)
    }
  }

  async function retrySaved() {
    if (!intent) return
    await submitCheckout({ key: intent.key, scenario: intent.scenario, ...(intent.cart_id === null ? {} : { cartId: intent.cart_id }) })
  }

  async function timeoutDemo() { await submitCheckout({ abortAfterMs: 250 }) }

  async function doubleCheckout() {
    if (!cart || busy) return
    const keys = [makeKey(), makeKey()]
    const results = await Promise.all(keys.map((key) => submitCheckout({ key, cartId: cart.id, open: false, allowConcurrent: true })))
    setResponses(results.map((result, index) => result ? `Request ${index + 1}: ${result.status} payment #${result.id} (${result.reference})` : `Request ${index + 1}: no response; inspect saved checkout intent before trying again.`))
    const first = results.find((result): result is CheckoutResponse => Boolean(result))
    if (first) {
      const data = await api.get<PaymentDetail>(`/v1/payments/${first.id}`)
      if (identity && data.payment_url && isProviderUrl(data.payment_url, config.PROVIDER_ORIGIN)) {
        rememberPaymentDialog(identity.user.id, data.id)
        setDismissedPaymentId(data.id)
        setActivePayment({ id: data.id, reference: data.reference, url: data.payment_url })
      }
    }
    await refresh().catch(() => undefined)
  }

  const refreshPayment = useCallback(async (paymentId: number) => {
    try {
      const payment = await api.get<PaymentDetail>(`/v1/payments/${paymentId}`)
      if (payment.status === 'success' || payment.status === 'failed' || payment.status === 'cancelled') {
        setActivePayment(null)
        setLastPayment(payment)
        if (intent?.payment_id === paymentId) {
          localStorage.removeItem(checkoutKey)
          setIntent(null)
        }
      }
      setNotice(`Payment ${payment.reference} is ${payment.status}.`)
      await refresh().catch(() => undefined)
    } catch (reason) { setError(describeError(reason)) }
  }, [api, intent?.payment_id, refresh])

  useEffect(() => {
    if (!event || !intent?.payment_id || event.payment_id !== intent.payment_id ||
        !['payment_succeeded', 'payment_failed', 'payment_cancelled'].includes(event.type)) return
    void refreshPayment(event.payment_id)
  }, [event, intent?.payment_id, refreshPayment])

  useEffect(() => {
    if (connection === 'connected' && intent?.payment_id) void refreshPayment(intent.payment_id)
  }, [connection, intent?.payment_id, refreshPayment])

  const onProviderHint = useCallback((reference: string) => {
    const current = activePayment
    if (!current || current.reference !== reference) return
    if (identity) rememberPaymentDialog(identity.user.id, current.id)
    setDismissedPaymentId(current.id)
    setActivePayment(null)
    setNotice('Provider finished. Confirming payment status with the API…')
    void refreshPayment(current.id)
  }, [activePayment, identity, refreshPayment])

  const totalPages = Math.max(1, Math.ceil(meta.total / meta.page_size))
  const latestPayment = useMemo(() => cart?.payments?.[0], [cart])

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-sm font-semibold uppercase tracking-widest text-sky-800">Storefront</p><h1 className="mt-1 text-3xl font-extrabold">Products and Cart</h1><p className="mt-2 text-slate-600">Prices, availability, totals, and payment state come from the API.</p></div>
      <Button variant="outline" onClick={() => { void refresh(); void refreshScenarios() }}>Refresh Products and Cart</Button>
    </div>

    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-rose-900">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sky-950">{notice}</p>}

    <Card>
      <CardHeading>Payment Failure Scenario</CardHeading>
      <p className="mb-3 text-sm text-slate-600"><span className="font-medium">Payment Provider Failure Cases</span> are optional. Client demos below can be used instead of a provider scenario.</p>
      <label className="grid max-w-2xl gap-2 font-medium" htmlFor="scenario">Provider Scenario
        <select id="scenario" disabled={busy} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 disabled:bg-slate-100" value={scenario} onChange={(event) => setScenario(event.target.value)}>
          <option value="">Standard Checkout</option>
          {scenarios.map((entry) => <option key={entry.code} value={entry.code}>{entry.name} ({entry.code})</option>)}
        </select>
      </label>
      {intent && <p className="mt-2 text-sm text-amber-900">A checkout outcome is pending or uncertain. You can choose a scenario for a future checkout; use the saved key to retry this attempt. {intent.payment_id && <Link className="font-semibold underline" to="/payments">View Payment Status</Link>}</p>}
      {scenarioError && <p className="mt-2 text-sm text-amber-900">Scenario catalogue unavailable: {scenarioError} Standard checkout remains available.</p>}
    </Card>

    <section aria-labelledby="products-heading">
      <div className="mb-3 flex items-center justify-between"><h2 id="products-heading" className="text-xl font-bold">Available Products</h2><span className="text-sm text-slate-600">Page {meta.page} of {totalPages}</span></div>
      {loading ? <p role="status">Loading Products…</p> : products.length === 0 ? <Card>No products are currently available.</Card> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => <Card key={product.id} className="flex flex-col">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{product.sku}</p><h3 className="mt-2 text-lg font-bold">{product.name}</h3><p className="mt-1 flex-1 text-sm text-slate-600">{product.description}</p>
          <p className="mt-4 text-lg font-bold">{money(product.price_minor, product.currency)}</p><p className="mt-1 text-sm text-slate-600">{product.available_stock} available</p>
          <div className="mt-4 flex items-end gap-2"><label className="grid gap-1 text-sm" htmlFor={`qty-${product.id}`}>Qty<input id={`qty-${product.id}`} type="number" min="1" max={product.available_stock} value={quantity[product.id] ?? 1} onChange={(event) => setQuantity({ ...quantity, [product.id]: Number(event.target.value) })} className="h-10 w-20 rounded border border-slate-300 px-2" /></label><Button disabled={busy || product.available_stock < 1} onClick={() => void add(product)}>Add to Cart</Button></div>
        </Card>)}
      </div>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="outline" disabled={meta.page <= 1} onClick={() => setMeta({ ...meta, page: meta.page - 1 })}>Previous</Button><Button variant="outline" disabled={meta.page >= totalPages} onClick={() => setMeta({ ...meta, page: meta.page + 1 })}>Next</Button></div>
    </section>

    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><CardHeading>Active Cart</CardHeading><p className="text-sm text-slate-600">{cart ? `Cart #${cart.id} · ${cart.status}` : 'No active cart'}</p></div>{cart && <Button variant="outline" disabled={busy} onClick={() => void abandonCart()}>Abandon Cart</Button>}</div>
      {!cart || cart.items.length === 0 ? <p className="text-slate-600">Your cart is empty.</p> : <>
        <ul className="divide-y divide-slate-200">{cart.items.map((item) => <li key={item.product_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><p className="font-semibold">{item.product_name}</p><p className="text-sm text-slate-600">{money(item.unit_price_minor, item.currency ?? cart.currency)} each · line total {money(item.line_total_minor, item.currency ?? cart.currency)}</p></div>
          <div className="flex items-end gap-2"><label className="grid gap-1 text-xs" htmlFor={`cart-qty-${item.product_id}`}>Quantity<input id={`cart-qty-${item.product_id}`} type="number" min="1" value={item.quantity} onChange={(event) => void updateQuantity(item.product_id, Number(event.target.value))} className="h-10 w-20 rounded border border-slate-300 px-2 text-sm" /></label><Button variant="ghost" onClick={() => void removeItem(item.product_id)}>Remove</Button></div>
        </li>)}</ul>
        <p className="mt-3 text-right text-xl font-bold">Total from API: {money(cart.total_minor, cart.currency)}</p>
        {latestPayment && <p className="mt-2 text-sm">Latest Attempt: <Link className="underline" to={`/payments/${latestPayment.id}`}>{latestPayment.reference} — {latestPayment.status}</Link></p>}
        {latestPayment?.status === 'pending' && <p className="mt-2 text-sm text-amber-900">A payment is pending. Reuse the saved key after an uncertain checkout response. <Link className="font-semibold underline" to="/payments">View Payment Status</Link></p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy || cart.status !== 'active'} onClick={() => void submitCheckout()}>Checkout</Button>
          <Button variant="outline" disabled={busy || !cart.items.length || Boolean(scenario)} onClick={() => void timeoutDemo()}>Demo Client Timeout</Button>
          <Button variant="outline" disabled={busy || !cart.items.length || Boolean(scenario)} onClick={() => void doubleCheckout()}>Demo Double Checkout</Button>
        </div>
        {responses.length > 0 && <ul aria-label="Double Checkout Responses" className="mt-3 list-disc pl-5 text-sm">{responses.map((response) => <li key={response}>{response}</li>)}</ul>}
      </>}
    </Card>

    {intent && <Card className="border-amber-300 bg-amber-50"><CardHeading>Payment Status</CardHeading><p>{intent.payment_id ? `Attempt ${intent.reference ?? `#${intent.payment_id}`} is not assumed complete until the API confirms a state.` : 'The checkout result is uncertain. The API may already have accepted this attempt.'}</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void retrySaved()}>Retry With Saved Key</Button>{intent.payment_id && <><Button variant="outline" onClick={() => void refreshPayment(intent.payment_id!)}>Refresh Payment</Button><Link className="self-center underline" to={`/payments/${intent.payment_id}`}>View Payment Details</Link></>}</div></Card>}
    {lastPayment && <Card className="border-amber-300 bg-amber-50"><CardHeading>Payment Status</CardHeading><p>Payment {lastPayment.reference} is confirmed {lastPayment.status} by the API.</p><Link className="mt-3 inline-block underline" to={`/payments/${lastPayment.id}`}>View Payment Details</Link></Card>}

    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><CardHeading>Live Payment Updates</CardHeading><p aria-live="polite">{connection === 'connected' ? 'Connected to API events.' : connection === 'connecting' ? 'Connecting…' : 'Updates disconnected.'}</p></div>{connection === 'connected' ? <Button variant="outline" onClick={disconnect}>Demo SSE Disconnect</Button> : <Button variant="outline" onClick={reconnect}>Reconnect Updates</Button>}</div>
    </Card>

    <PaymentDialog payment={activePayment} providerOrigin={config.PROVIDER_ORIGIN} onClose={() => {
      if (activePayment && identity) {
        rememberPaymentDialog(identity.user.id, activePayment.id)
        setDismissedPaymentId(activePayment.id)
      }
      setActivePayment(null)
    }} onFinished={onProviderHint} />
  </div>
}
