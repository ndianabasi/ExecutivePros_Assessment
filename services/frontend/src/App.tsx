import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import { useLayoutEffect, useRef } from 'react'
import { PaymentEventProvider } from './events'
import { Shell } from './components/Shell'
import { LoginPage } from './pages/LoginPage'
import { PaymentDetailPage } from './pages/PaymentDetailPage'
import { PaymentsPage } from './pages/PaymentsPage'
import { ProductsPage } from './pages/ProductsPage'
import { useSession } from './session'

/**
 * Redirects the application root to the storefront when a demo identity is selected.
 */
function RootRedirect() {
  const { identity } = useSession()
  return <Navigate to={identity ? '/products' : '/login'} replace />
}

/**
 * Redirects unauthenticated visitors to demo login before rendering protected routes.
 */
function Protected() {
  const { identity } = useSession()
  return identity ? <Outlet /> : <Navigate to="/login" replace />
}

/**
 * Aborts requests from the previous route so stale results cannot overwrite the active page.
 */
function RouteRequestCleanup() {
  const { pathname } = useLocation()
  const { api } = useSession()
  const previousPath = useRef(pathname)
  useLayoutEffect(() => {
    if (previousPath.current !== pathname) {
      api.abortAll()
    }
    previousPath.current = pathname
  }, [api, pathname])
  return null
}

/**
 * Composes session and event providers with the public and protected application routes.
 */
export function App() {
  return (
    <PaymentEventProvider>
      <RouteRequestCleanup />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Protected />}>
          <Route element={<Shell />}>
            <Route path="/" element={<RootRedirect />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/payments/:paymentId" element={<PaymentDetailPage />} />
          </Route>
        </Route>
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </PaymentEventProvider>
  )
}
