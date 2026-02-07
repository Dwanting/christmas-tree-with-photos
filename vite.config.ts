import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import photoServer from './vite-plugin-photo-server'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const isDev = command === 'serve' && mode !== 'production'
  const base = isDev ? '/' : '/christmas-tree-with-photos/'

  return {
    plugins: [react(), photoServer()],
    base,
    server: {
      open: base
    }
  }
})
