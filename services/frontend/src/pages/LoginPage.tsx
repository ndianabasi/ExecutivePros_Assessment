import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../api'
import { useSession } from '../session'
import type { DemoUser } from '../model'
import { Button } from '../components/ui/button'
import { Card, CardHeading } from '../components/ui/card'

export function LoginPage() {
  const { api, identity, setLogin } = useSession()
  const navigate = useNavigate()
  const [users, setUsers] = useState<DemoUser[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (identity) { navigate('/products', { replace: true }); return }
    const controller = new AbortController()
    setLoading(true)
    api.get<DemoUser[]>('/v1/demo/users', { public: true, signal: controller.signal })
      .then((response) => setUsers(response.filter((user) => user.role === 'user' || user.role === 'admin')))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load demo users.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, identity, navigate])

  async function login() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const result = await api.post<{ token: string; user: DemoUser }>('/v1/login', { user_id: Number(selected) }, { public: true })
      if (!result || typeof result.token !== 'string' || !result.user || !['user', 'admin'].includes(result.user.role)) throw new Error('The API returned an invalid demo identity.')
      setLogin(result)
      navigate('/products', { replace: true })
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : 'Login failed. Please retry.')
    } finally { setBusy(false) }
  }

  return <div className="mx-auto max-w-xl py-12">
    <Card>
      <p className="text-sm font-semibold uppercase tracking-widest text-sky-800">Trusted Assessment Demo</p>
      <CardHeading className="mt-2 text-2xl">Choose a Demo User</CardHeading>
      <p className="mb-5 text-slate-600">Passwordless access is enabled only for this trusted demo. The API enforces every role and payment rule.</p>
      {loading ? <p role="status">Loading active users…</p> : <label className="grid gap-2 font-medium" htmlFor="demo-user">User
        <select id="demo-user" className="min-h-11 rounded-lg border border-slate-300 bg-white px-3" value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Select a User</option>
          {users.map((user) => <option key={user.id} value={user.id}>{user.first_name} {user.last_name} — {user.role}</option>)}
        </select>
      </label>}
      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-rose-900">{error} <button className="ml-2 underline" onClick={() => window.location.reload()}>Retry</button></p>}
      {!loading && users.length === 0 && !error && <p className="mt-4">No active demo users are available.</p>}
      <Button className="mt-5 w-full" disabled={!selected || busy || loading} onClick={() => void login()}>{busy ? 'Signing In…' : 'Select User'}</Button>
    </Card>
  </div>
}
