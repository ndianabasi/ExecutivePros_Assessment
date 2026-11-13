import express, { type Express, type Request, type Response } from 'express'

export interface AppDependencies {
  isReady: () => boolean
}

export function createApp({ isReady }: AppDependencies): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb', strict: true }))

  app.get('/health/live', (_request: Request, response: Response) => {
    response.status(200).json({ status: 'live' })
  })

  app.get('/health/ready', (_request: Request, response: Response) => {
    if (!isReady()) return response.status(503).json({ status: 'not_ready' })
    return response.status(200).json({ status: 'ready' })
  })

  return app
}
