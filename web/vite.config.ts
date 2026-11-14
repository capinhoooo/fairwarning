import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import netlify from '@netlify/vite-plugin-tanstack-start'

// Netlify builds use its own adapter instead of Nitro (netlify.toml sets DEPLOY_TARGET)
const onNetlify = process.env.DEPLOY_TARGET === 'netlify'

const config = defineConfig({
  // gsap's plugin entries are CommonJS to Node; bundle them so SSR named imports resolve
  ssr: { noExternal: ['gsap'] },
  plugins: [
    // DEVTOOLS_PORT avoids clashing with another TanStack app's bus on 42069
    devtools({
      eventBusConfig: { port: Number(process.env.DEVTOOLS_PORT) || 42069 },
    }),
    onNetlify ? netlify() : nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
