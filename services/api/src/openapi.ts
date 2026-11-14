type Operation = {
  operationId: string
  summary: string
  tags: string[]
  security?: Array<Record<string, string[]>>
  parameters?: Array<Record<string, unknown>>
  requestBody?: Record<string, unknown>
  responses: Record<string, unknown>
}

const jsonResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } })
const operation = (_method: string, operationId: string, summary: string, tags: string[], authenticated = true): Operation => ({
  operationId, summary, tags,
  ...(authenticated ? { security: [{ bearerAuth: [] }] } : {}),
  responses: { '200': jsonResponse('Successful response'), '400': jsonResponse('Invalid request'),
    '401': jsonResponse('Authentication failed'), '404': jsonResponse('Resource not found'),
    '500': jsonResponse('Unexpected server error') },
})

function request(operationValue: Operation, schema: Record<string, unknown> = { type: 'object' }) {
  operationValue.requestBody = { required: true, content: { 'application/json': { schema } } }
  return operationValue
}

const paths: Record<string, Record<string, Operation | Record<string, unknown>>> = {
  '/health/live': { get: { ...operation('get', 'liveHealth', 'Check process liveness', ['Health'], false), responses: { '200': jsonResponse('Process is live') } } },
  '/health/ready': { get: { ...operation('get', 'readyHealth', 'Check API database readiness', ['Health'], false), responses: { '200': jsonResponse('Ready'), '503': jsonResponse('Not ready') } } },
  '/v1/demo/users': { get: { ...operation('get', 'listDemoUsers', 'List selectable seeded users for the trusted assessment demo', ['Authentication'], false), responses: { '200': jsonResponse('Seeded demo users') } } },
  '/v1/login': { post: request({ ...operation('post', 'login', 'Issue a bearer token for a seeded demo user', ['Authentication'], false), responses: { '200': jsonResponse('Token and minimal user profile'), '400': jsonResponse('Invalid user ID'), '401': jsonResponse('Unknown or inactive user') } }, { type: 'object', required: ['user_id'], properties: { user_id: { type: 'integer', minimum: 1 } }, additionalProperties: false }) },
  '/v1/logout': { post: operation('post', 'logout', 'Revoke the current bearer token', ['Authentication']) },
  '/v1/products': { get: operation('get', 'listProducts', 'List active products and available stock', ['Products']) },
  '/v1/cart': {
    get: operation('get', 'getActiveCart', 'Read the current active cart', ['Cart']),
    post: request(operation('post', 'addCartItem', 'Create an active cart and add an item', ['Cart'])),
    delete: operation('delete', 'abandonCart', 'Abandon an active cart', ['Cart']),
  },
  '/v1/cart/items/{product_id}': {
    patch: request(operation('patch', 'setCartItemQuantity', 'Set an active cart item quantity', ['Cart'])),
    delete: operation('delete', 'removeCartItem', 'Remove an active cart item', ['Cart']),
  },
  '/v1/carts/{cart_id}': { get: operation('get', 'getCart', 'Read a cart and its payment attempts', ['Cart']) },
  '/v1/failure-scenarios': { get: operation('get', 'listFailureScenarios', 'List provider payment demo scenarios', ['Payments']) },
  '/v1/cart/checkout': { post: request({ ...operation('post', 'checkout', 'Create or replay an idempotent payment attempt', ['Payments']),
    parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }],
    responses: { '201': jsonResponse('New ready payment'), '200': jsonResponse('Idempotent payment replay'), '202': jsonResponse('Initialization pending'), '400': jsonResponse('Invalid request'), '409': jsonResponse('Checkout conflict'), '503': jsonResponse('Provider unavailable') } }) },
  '/v1/webhooks/payment': { post: { ...operation('post', 'receivePaymentWebhook', 'Receive signed provider payment status evidence', ['Webhooks'], false),
    security: [{ providerWebhookHmac: [] }],
    parameters: [{ in: 'header', name: 'X-Provider-Signature', required: true, schema: { type: 'string', pattern: '^sha256=' } }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentWebhook' } } } },
    responses: { '200': jsonResponse('Accepted or duplicate event'), '400': jsonResponse('Malformed event'), '401': jsonResponse('Invalid signature'), '409': jsonResponse('Event ID conflict'), '422': jsonResponse('Payment evidence mismatch'), '503': jsonResponse('Transient processing failure') } } },
  '/v1/payments': { get: operation('get', 'listPayments', 'List own payments or all payments for an admin', ['Payments']) },
  '/v1/payments/{payment_id}': { get: operation('get', 'getPayment', 'Read a payment and fulfillment details', ['Payments']) },
  '/v1/events': { get: { ...operation('get', 'paymentEvents', 'Stream owner-scoped payment status updates', ['Events']),
    responses: { '200': { description: 'Server-sent payment status events', content: { 'text/event-stream': { schema: { type: 'string' } } }, '401': jsonResponse('Authentication failed') } } } },
  '/v1/admin/diagnostics': { get: operation('get', 'getAdminDiagnostics', 'Read payment and notification backlog counters', ['Operations']) },
}

export function apiOpenApiDocument(apiOrigin: string) {
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: {
      title: 'ExecutivePros Assessment API', version: '1.0.0',
      description: 'Trusted assessment demo API. Seeded-user passwordless login is demo-only. Payment status can only change through signed provider webhooks, authenticated provider reconciliation, or expiry processing; there is no manual payment-status endpoint. Amount, currency, stock, and payment state are server-owned.',
    },
    servers: [{ url: apiOrigin }],
    tags: [{ name: 'Authentication' }, { name: 'Products' }, { name: 'Cart' }, { name: 'Payments' }, { name: 'Webhooks' }, { name: 'Events' }, { name: 'Operations' }, { name: 'Health' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
        providerWebhookHmac: { type: 'apiKey', in: 'header', name: 'X-Provider-Signature', description: 'HMAC-SHA256 over the exact raw request bytes; this is not a bearer token.' },
      },
      schemas: {
        Envelope: { type: 'object', properties: { data: {}, meta: { type: 'object' }, error: { $ref: '#/components/schemas/Error' } }, additionalProperties: false },
        Error: { type: 'object', required: ['code', 'message', 'request_id'], properties: { code: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string' }, details: {} }, additionalProperties: false },
        PaymentWebhook: { type: 'object', required: ['event_id', 'event_type', 'status', 'reference', 'amount', 'currency', 'occurred_at'], properties: { event_id: { type: 'string' }, event_type: { type: 'string' }, status: { type: 'string', enum: ['success', 'failed', 'cancelled'] }, reference: { type: 'string' }, provider_reference: { type: 'string' }, amount: { type: 'integer', minimum: 1 }, currency: { type: 'string' }, occurred_at: { type: 'string', format: 'date-time' } }, additionalProperties: false },
      },
    },
  }
}
