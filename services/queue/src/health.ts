import { Router } from 'express'

export interface QueueHealthDependencies {
  isDbWritable(): boolean
  isWorkerRunning(): boolean
}

/**
 * Creates health endpoints for process liveness and service readiness checks.
 *
 * @param dependencies - Service dependencies and runtime capabilities injected into the application factory.
 *
 * @returns The configured object, route set, or resource produced by this operation.
 */
export function createHealthRouter(dependencies: QueueHealthDependencies): Router {
  const router = Router()
  router.get('/live', (_request, response) => {
    return response.status(200).json({ status: 'ok' })
  })
  router.get('/ready', (_request, response) => {
    const ready = dependencies.isDbWritable() && dependencies.isWorkerRunning()
    return response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' })
  })
  return router
}
