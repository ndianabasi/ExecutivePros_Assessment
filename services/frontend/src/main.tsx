import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { parseRuntimeConfig } from './origins'
import { SessionProvider } from './session'
import './styles.css'

async function start() {
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  try {
    const response = await fetch('/config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw new Error(`Runtime configuration unavailable (${response.status})`)
    const config = parseRuntimeConfig(await response.json())
    root.render(<React.StrictMode><BrowserRouter><SessionProvider config={config}><App /></SessionProvider></BrowserRouter></React.StrictMode>)
  } catch (error) {
    root.render(<main className="config-error"><h1>Configuration Error</h1><p role="alert">{error instanceof Error ? error.message : 'The frontend cannot start without valid service origins.'}</p><button onClick={() => window.location.reload()}>Retry</button></main>)
  }
}

void start()
