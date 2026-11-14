import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './support/server'

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  localStorage.clear()
})
afterAll(() => server.close())
