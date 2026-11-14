export type Role = 'user' | 'admin'

export interface DemoUser {
  id: number
  first_name: string
  last_name: string
  role: Role
  email?: string
}

export interface Identity {
  token: string
  user: DemoUser
}

export interface RuntimeConfig {
  API_ORIGIN: string
  PROVIDER_ORIGIN: string
  DOCS_ORIGIN: string
  MAILPIT_ORIGIN: string
}

export interface Product {
  id: number
  name: string
  description: string
  sku: string
  price_minor: number
  currency: string
  available_stock: number
}

export interface CartItem {
  product_id: number
  product_name: string
  unit_price_minor: number
  quantity: number
  line_total_minor: number
  currency?: string
}

export interface Cart {
  id: number
  user_id: number
  status: string
  currency: string
  total_minor: number
  items: CartItem[]
  payments: PaymentSummary[]
}

export interface PaymentSummary {
  id: number
  reference: string
  cart_id: number
  status: 'pending' | 'success' | 'failed' | 'cancelled'
  amount_minor: number
  currency: string
  payment_url?: string | null
  initialisation_state?: string
  failure_scenario_code?: string | null
  created_at: string
  completed_at?: string | null
  fulfilled?: number
}

export interface FailureScenario {
  code: string
  name: string
  description: string
  category: string
}

export interface PageMeta {
  page: number
  page_size: number
  total: number
}

export type PaymentActivityType =
  | 'payment_pending'
  | 'provider_initialization_started'
  | 'provider_initialization_succeeded'
  | 'provider_initialization_retry_scheduled'
  | 'webhook_received'
  | 'webhook_verification_succeeded'
  | 'webhook_verification_failed'
  | 'webhook_result'
  | 'reconciliation_started'
  | 'reconciliation_completed'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_cancelled'

export interface PaymentActivityNotification {
  id: string
  type: PaymentActivityType
  payment_id: number
  reference: string
  occurred_at: string
  title: string
  message: string
  status?: PaymentSummary['status']
  source?: 'webhook' | 'reconciliation' | 'provider_initialization' | 'api'
  attempt_number?: number
  request_id?: string
}

export type PaymentEvent = PaymentActivityNotification

export interface ApiEnvelope<T> {
  data: T
  meta?: PageMeta
}

export interface PaymentDetail extends PaymentSummary {
  user_id: number
  provider_transaction_reference?: string | null
  cart: { id: number; items: CartItem[] }
  fulfillment: { created_at: string; items: CartItem[] } | null
  incidents: Array<{
    id: number
    code: string
    redacted_details?: string
    created_at: string
    resolved_at?: string | null
  }>
  reconciliation_attempts: Array<{
    id: number
    attempt_number: number
    outcome: string
    provider_status?: string | null
    redacted_details?: string | null
    started_at: string
    completed_at?: string | null
  }>
}
