import { ExternalLink } from 'lucide-react'
import { Link, NavLink, Outlet } from 'react-router'
import { Button } from './ui/button'
import { useSession } from '../session'
import { usePaymentEvents } from '../events'

export function Shell() {
  const { identity, config, logout } = useSession()
  const { connection } = usePaymentEvents()
  if (!identity) return <Outlet />
  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <Link to="/products" className="text-lg font-extrabold tracking-tight text-sky-900">ExecutivePros Demo</Link>
        <nav aria-label="Main Navigation" className="flex flex-wrap items-center gap-2">
          <NavLink to="/products" className={({ isActive }) => `rounded px-3 py-2 text-sm font-semibold ${isActive ? 'bg-sky-100 text-sky-950' : 'text-slate-700'}`}>Products</NavLink>
          <NavLink to="/payments" className={({ isActive }) => `rounded px-3 py-2 text-sm font-semibold ${isActive ? 'bg-sky-100 text-sky-950' : 'text-slate-700'}`}>Payments</NavLink>
          <a href={config.DOCS_ORIGIN} target="_blank" rel="noopener noreferrer" className="rounded px-3 py-2 text-sm font-semibold text-slate-700">API Docs <ExternalLink size={14} className="inline" aria-hidden="true" /></a>
          <a href={config.MAILPIT_ORIGIN} target="_blank" rel="noopener noreferrer" className="rounded px-3 py-2 text-sm font-semibold text-slate-700">Emails <ExternalLink size={14} className="inline" aria-hidden="true" /></a>
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-slate-600 sm:inline">{identity.user.first_name} {identity.user.last_name} ({identity.user.role})</span>
          <Button variant="outline" onClick={() => void logout()}>Switch User</Button>
        </div>
      </div>
    </header>
    <div aria-live="polite" className="mx-auto flex max-w-6xl items-center justify-between px-4 pt-3 text-sm text-slate-600">
      <span>{connection === 'connected' ? 'Payment updates connected' : connection === 'disconnected' || connection === 'connecting' ? 'Updates disconnected' : 'Updates stopped'}</span>
      <span className="sm:hidden">{identity.user.first_name} ({identity.user.role})</span>
    </div>
    <main className="mx-auto max-w-6xl px-4 py-6"><Outlet /></main>
  </div>
}
