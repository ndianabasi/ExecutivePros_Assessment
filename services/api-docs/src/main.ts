import { checkoutStorageKey, validateApiOrigin, validateOpenApi, type DemoIdentity } from './contracts.js'
import { createRequestInterceptor, createResponseInterceptor } from './request-guards.js'
import { specialOperationsPlugin } from './swagger-plugin.js'

declare global {
  type SwaggerBundle = ((options: Record<string, unknown>) => unknown) & { presets: { apis: unknown } }
  interface Window {
    SwaggerUIBundle: SwaggerBundle
    SwaggerUIStandalonePreset: unknown
    React: { createElement: (component: unknown, props: Record<string, unknown>) => unknown }
  }
}

const identityKey = 'api-docs.identity.v1'
const status = document.querySelector<HTMLElement>('#status')!
const selector = document.querySelector<HTMLSelectElement>('#seeded-user')!
const identityLabel = document.querySelector<HTMLElement>('#identity')!
const specRoot = document.querySelector<HTMLElement>('#swagger-ui')!
const apiBase = document.querySelector<HTMLElement>('#api-state')!
const loginButton = document.querySelector<HTMLButtonElement>('#select-user')!
const switchButton = document.querySelector<HTMLButtonElement>('#switch-user')!
const refreshUsersButton = document.querySelector<HTMLButtonElement>('#refresh-users')!
const usersState = document.querySelector<HTMLElement>('#user-state')!
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh-spec')!
const generateButton = document.querySelector<HTMLButtonElement>('#generate-key')!
const copyButton = document.querySelector<HTMLButtonElement>('#copy-key')!
const keyField = document.querySelector<HTMLInputElement>('#checkout-key')!
let apiOrigin = ''
let identity: DemoIdentity | null = readIdentity()
let currentSpec: Record<string, unknown> | null = null

/**
 * Updates the API documentation page status region with an accessible success or error message.
 *
 * @param message - Safe human-readable message shown to the API caller or demo user.
 * @param isError - Whether the captured value represents an error response rather than a success response.
 */
function announce(message: string, isError = false): void {
  status.textContent = message
  status.setAttribute('role', isError ? 'alert' : 'status')
}

/**
 * Loads and validates the locally stored demo identity, removing malformed credentials.
 *
 * @returns The requested value or matching records from the configured service source.
 */
function readIdentity(): DemoIdentity | null {
  const raw = localStorage.getItem(identityKey)
  if (!raw) {
    return null
  }
  try {
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) {
      localStorage.removeItem(identityKey)
      return null
    }
    const value = stored as Partial<DemoIdentity>
    if (
      typeof value.token !== 'string' ||
      value.token.length < 16 ||
      typeof value.user !== 'object' ||
      value.user === null
    ) {
      localStorage.removeItem(identityKey)
      return null
    }
    const user = value.user as Partial<DemoIdentity['user']>
    if (
      !Number.isSafeInteger(user.user_id) ||
      typeof user.name !== 'string' ||
      !['user', 'admin'].includes(user.role ?? '')
    ) {
      localStorage.removeItem(identityKey)
      return null
    }
    return {
      token: value.token,
      user: { user_id: user.user_id!, name: user.name, role: user.role as 'user' | 'admin' },
    }
  } catch {
    localStorage.removeItem(identityKey)
    return null
  }
}

/**
 * Writes the selected identity to local storage and refreshes the documentation controls that depend on it.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 */
function setIdentity(value: DemoIdentity | null): void {
  const previousUserId = identity?.user.user_id
  identity = value
  if (value) {
    localStorage.setItem(identityKey, JSON.stringify(value))
  } else {
    localStorage.removeItem(identityKey)
  }
  if (previousUserId !== undefined && previousUserId !== value?.user.user_id) {
    localStorage.removeItem(checkoutStorageKey(previousUserId))
  }
  refreshIdentityUI()
}

/**
 * Updates the API documentation controls to reflect the currently selected demo identity.
 */
function refreshIdentityUI(): void {
  identityLabel.textContent = identity
    ? `Selected: ${identity.user.name} (${identity.user.role})`
    : 'No user selected'
  loginButton.hidden = identity !== null
  loginButton.disabled = identity !== null || selector.disabled || !selector.value
  selector.hidden = identity !== null
  switchButton.hidden = identity === null
  keyField.disabled = identity === null
  generateButton.disabled = identity === null
  copyButton.disabled = identity === null || !keyField.value
  keyField.value = identity ? (localStorage.getItem(checkoutStorageKey(identity.user.user_id)) ?? '') : ''
}

/**
 * Fetches a no-store JSON resource and reports a safe error when the API response is unsuccessful.
 *
 * @param url - Request URL or configured service URL used to resolve the target resource.
 *
 * @returns The requested value or matching records from the configured service source.
 */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', credentials: 'omit' })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  return response.json() as Promise<unknown>
}

/**
 * Loads active seeded users from the API and populates the documentation demo user selector.
 */
async function loadUsers(): Promise<void> {
  const hadChoices = selector.options.length > 1
  refreshUsersButton.disabled = true
  usersState.dataset.state = 'loading'
  usersState.textContent = 'Loading seeded users…'
  if (!hadChoices) {
    selector.replaceChildren(new Option('Loading seeded users…', ''))
  }
  selector.disabled = true
  try {
    const result = (await getJson(`${apiOrigin}/v1/demo/users`)) as {
      data?: Array<{ id: number; first_name: string; last_name: string; role: string }>
    }
    if (!Array.isArray(result.data)) {
      throw new Error('The API returned an invalid seeded-user list')
    }
    const users = result.data.filter((user) => {
      return (
        Number.isSafeInteger(user.id) &&
        user.id > 0 &&
        typeof user.first_name === 'string' &&
        typeof user.last_name === 'string' &&
        ['user', 'admin'].includes(user.role)
      )
    })
    if (!users.length) {
      throw new Error('The API returned no active seeded users.')
    }
    const options = [
      new Option('Choose a seeded user', ''),
      ...users.map((user) => {
        return new Option(`${user.first_name} ${user.last_name} — ${user.role}`, String(user.id))
      }),
    ]
    selector.replaceChildren(...options)
    selector.disabled = identity !== null
    loginButton.disabled = identity !== null || !selector.value
    usersState.dataset.state = 'ready'
    usersState.textContent = `${users.length} seeded ${users.length === 1 ? 'user is' : 'users are'} available.`
  } catch (error) {
    if (!hadChoices) {
      selector.replaceChildren(new Option('Seeded users unavailable', ''))
    }
    loginButton.disabled = true
    usersState.dataset.state = 'error'
    usersState.textContent = `${error instanceof Error ? error.message : 'Could not load seeded users.'} Use Retry user discovery when the API is ready.`
    throw error
  } finally {
    selector.disabled = identity !== null || selector.options.length <= 1
    loginButton.disabled = identity !== null || selector.disabled || !selector.value
    refreshUsersButton.disabled = false
  }
  selector.hidden = identity !== null
}

/**
 * Logs in the selected seeded user, stores the returned identity, and refreshes protected API controls.
 */
async function selectUser(): Promise<void> {
  const userId = Number(selector.value)
  if (!Number.isSafeInteger(userId) || userId < 1) {
    announce('Choose a seeded user first.', true)
    return
  }
  loginButton.disabled = true
  try {
    const response = await fetch(`${apiOrigin}/v1/login`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    })
    const result = (await response.json()) as {
      data?: {
        token?: unknown
        user?: { id: number; first_name: string; last_name: string; role: 'user' | 'admin' }
      }
    }
    if (
      !response.ok ||
      typeof result.data?.token !== 'string' ||
      !result.data.user ||
      result.data.user.id !== userId ||
      !['user', 'admin'].includes(result.data.user.role)
    ) {
      throw new Error('The API could not select that seeded user')
    }
    setIdentity({
      token: result.data.token,
      user: {
        user_id: userId,
        name: `${result.data.user.first_name} ${result.data.user.last_name}`,
        role: result.data.user.role,
      },
    })
    announce(`Signed in as ${identity!.user.name}.`)
  } catch (error) {
    announce(
      error instanceof Error ? error.message : 'Could not sign in. Retry when the API is available.',
      true,
    )
  } finally {
    loginButton.disabled = false
  }
}

/**
 * Revokes the current API token when possible and clears the locally selected documentation identity.
 */
async function switchUser(): Promise<void> {
  const old = identity
  try {
    if (old) {
      await fetch(`${apiOrigin}/v1/logout`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: { authorization: `Bearer ${old.token}` },
      })
    }
  } catch {
    /* Revocation is best effort; local credentials must still be cleared. */
  }
  setIdentity(null)
  selector.replaceChildren(new Option('Choose a seeded user', ''))
  try {
    await loadUsers()
    announce('Choose a seeded user.')
  } catch {
    announce('Signed out locally. The API is unavailable; retry user discovery.', true)
  }
}

/**
 * Installs Swagger UI with guarded request and response interceptors and the validated OpenAPI document.
 *
 * @param spec - Validated OpenAPI document used to check operation security and local references.
 */
function initializeSwagger(spec: Record<string, unknown>): void {
  currentSpec = spec
  specRoot.replaceChildren()
  window.SwaggerUIBundle({
    dom_id: '#swagger-ui',
    spec,
    presets: [window.SwaggerUIBundle.presets.apis, window.SwaggerUIStandalonePreset],
    plugins: [specialOperationsPlugin],
    validatorUrl: null,
    queryConfigEnabled: false,
    persistAuthorization: false,
    withCredentials: false,
    showMutatedRequest: false,
    requestSnippetsEnabled: false,
    supportedSubmitMethods: ['get', 'post', 'patch', 'delete'],
    requestInterceptor: createRequestInterceptor({
      origin: apiOrigin,
      spec: () => {
        return currentSpec
      },
      identity: () => {
        return identity
      },
    }),
    responseInterceptor: createResponseInterceptor({
      spec: () => {
        return currentSpec
      },
      onUnauthorized: () => {
        setIdentity(null)
        announce('Your selected identity has expired. Choose a seeded user again.', true)
      },
    }),
  })
}

/**
 * Fetches and validates the latest OpenAPI document before refreshing the documentation interface.
 */
async function refreshSpec(): Promise<void> {
  refreshButton.disabled = true
  specRoot.replaceChildren()
  try {
    const raw = await getJson(`${apiOrigin}/v1/api_docs.json`)
    const valid = validateOpenApi(raw, apiOrigin)
    initializeSwagger(valid)
    announce('Live API specification loaded.')
  } catch (error) {
    currentSpec = null
    announce(
      error instanceof Error
        ? `Specification unavailable: ${error.message}. Retry when the API is ready.`
        : 'Specification unavailable. Retry when the API is ready.',
      true,
    )
  } finally {
    refreshButton.disabled = false
  }
}

/**
 * Stores and displays the checkout idempotency key used by the API documentation examples.
 *
 * @param value - Input value to validate, normalize, encode, or persist.
 */
function updateKey(value: string): void {
  keyField.value = value
  if (identity && value) {
    localStorage.setItem(checkoutStorageKey(identity.user.user_id), value)
  }
  copyButton.disabled = !identity || !value
}

loginButton.addEventListener('click', () => {
  return void selectUser()
})
switchButton.addEventListener('click', () => {
  return void switchUser()
})
selector.addEventListener('change', () => {
  loginButton.disabled = identity !== null || selector.disabled || !selector.value
})
refreshUsersButton.addEventListener('click', () => {
  return void loadUsers()
    .then(() => {
      return announce('Seeded-user list refreshed.')
    })
    .catch((error) => {
      return announce(error instanceof Error ? error.message : 'Could not refresh seeded users.', true)
    })
})
refreshButton.addEventListener('click', () => {
  return void refreshSpec()
})
generateButton.addEventListener('click', () => {
  if (!identity || !crypto.randomUUID) {
    announce('Secure key generation is unavailable in this browser.', true)
    return
  }
  updateKey(crypto.randomUUID())
  announce('New checkout key generated. Paste it into the Idempotency-Key header.')
})
copyButton.addEventListener('click', () => {
  return void navigator.clipboard
    .writeText(keyField.value)
    .then(() => {
      return announce('Checkout key copied.')
    })
    .catch(() => {
      return announce('Copy failed; select and copy the key manually.', true)
    })
})
refreshIdentityUI()

try {
  const config = (await getJson('/config.json')) as { API_ORIGIN?: unknown }
  apiOrigin = validateApiOrigin(config.API_ORIGIN)
  apiBase.textContent = `API origin: ${apiOrigin}`
  try {
    await loadUsers()
  } catch {
    announce('The API is unavailable. Retry user discovery or refresh the specification.', true)
  }
  await refreshSpec()
} catch (error) {
  announce(
    error instanceof Error
      ? `Documentation configuration error: ${error.message}`
      : 'Documentation configuration is invalid.',
    true,
  )
  refreshButton.disabled = true
}
