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

export interface PaymentEvent {
  payment_id: number
  reference: string
  status: PaymentSummary['status']
  request_id?: string
}

export interface ApiEnvelope<T> {
  data: T
  meta?: PageMeta
}

export interface PaymentDetail extends PaymentSummary {
  user_id: number
  provider_transaction_reference?: string | null
  cart: { id: number; items: CartItem[] }
  fulfillment: { created_at: string; items: CartItem[] } | null
  incidents: Array<{ id: number; code: string; redacted_details?: string; created_at: string; resolved_at?: string | null }>
}
