import { Router } from 'express'

export interface QueueHealthDependencies {
  isDbWritable(): boolean
  isWorkerRunning(): boolean
}

export function createHealthRouter(dependencies: QueueHealthDependencies): Router {
  const router = Router()
  router.get('/live', (_request, response) => response.status(200).json({ status: 'ok' }))
  router.get('/ready', (_request, response) => {
    const ready = dependencies.isDbWritable() && dependencies.isWorkerRunning()
    return response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' })
  })
  return router
}
